# SP1 · M4 — Browser Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ] `) syntax for tracking.

**Scope:** migration step **M4 only** of the SP1 spec. The owner's browser is fed by the hub: the `/ws`
gateway pushes the hub's prices (`ticks$`, M3's `HubEngine.onPrice`), and the quote, depth, indices and
watchlist REST endpoints answer from the hub's PriceBook. The browser stops its 2–3 s polls (and the 5 s
indices/watchlist polls, and the chart's 20 s live-edge poll) while its feed is hub-served and Live. The
gateway's `toTokenRef` NSE hard-code is fixed for every user. Out of scope: the option chain (M5),
chart-context's 60 s poll and the remaining REST consumers (M6), `ManualTradePage`'s held-position quote
poll (see Notes), deleting `MarketFeedService.addViewing` / `POST /instruments/:token/watch` (M6), and the
other gateways (`/ws/trades`, `/ws/auto-trade`, …).

**Goal:** On the owner's account the header badge reads **Live** for the whole NSE session, and an open
chart + order ticket + depth card + watchlist + market overview make **no** periodic REST calls while the
feed is Live (no polling storm). Every number the owner's browser shows comes from the hub's one
broker session. Other users keep today's path unchanged, except that their subscriptions now carry the
right exchange. One flag, `HUB_SERVES_BROWSER`, reverts the owner to the legacy path with no deploy.

**Architecture:** The M3 seam gains a third consumer: `hubFor(userId, 'browser')` returns the owner's hub
only for the owner, only while the hub runs and `HUB_SERVES_BROWSER` is on, and `null` otherwise (never
for `userId === null`). The gateway resolves `HUB_PRICE_SOURCE` lazily through `ModuleRef`, as the
M3 consumers do. On connect it tells the browser `feed-source: 'hub' | 'legacy'`. For a hub-served socket,
`subscribe` becomes `hub.watch(refs, priority, 'browser:<socketId>', 120 s)` with the priority taken
from the purpose (`context` 2, `watchlist` 3, `chart` 4), renewed every 60 s and unwatched on
unsubscribe/disconnect; one `hub.onPrice` listener per hub-served user pushes every hub price to that
user's room as a Quote-compatible `tick`, coalesced per `EXCHANGE:token`. The legacy manager tick for a
hub-served user is dropped (same session, so it would be a duplicate). The REST endpoints read
`hub.price(ref, { maxAgeMs: 15 000 })` first through two pure functions (`serveQuotesFromHub`,
`serveDepthFromHub`, the M2 `serveChartFromHub` pattern) and fall back per instrument to their legacy
path. To make quotes and depth servable, the hub's `Price` gains the day bar (`day`, with the previous
close) and 5-level `depth`, parsed from the SNAP_QUOTE ticks and FULL quotes the session already
receives. In the browser one pure rule, `livePollMs(base, { source, health })`, turns each poll off while
`source === 'hub' && health === 'live'`, and back on as a fallback otherwise.

**Tech Stack:** NestJS 11, TypeScript 5.7, Socket.IO 4, Jest 29 (`ts-jest`, `isolatedModules`) for the
API; React 19 + Vite 6 + Vitest 2 (node environment, no DOM renderer) + Zustand 5 for the web app; pnpm
workspaces.

**Spec:** `docs/superpowers/specs/2026-10-05-sp1-market-data-hub-design.md` (§1.3 browser polls, §1.7
exchange mapping, §3.1 hub API, §5 live tier and PriceBook, §6.3 "the chart's live edge comes from
`ticks$`", §9 M4 row, §10, §11). Builds on the M1, M2 (`2026-10-08-sp1-m2-candle-store.md`) and M3
(`2026-10-09-sp1-m3-position-pricing.md`) plans.

**Branch:** `feature/sp1-m4-browser-feed`, from `main` (HEAD `357133f` at execution start).

**Test commands:**
- API: `pnpm --filter @td/api test -- <file-pattern>`. Jest `rootDir` is `apps/api/src`, `testRegex` is
  `.*\.spec\.ts$`. Example: `pnpm --filter @td/api test -- browser-feed.spec`.
- Web: `pnpm --filter @td/web test -- <file-pattern>` (`vitest run <filter>`; `*.spec.ts` and
  `*.test.ts` under `apps/web/src`, node environment). Example: `pnpm --filter @td/web test -- browser-feed`.

## Design decisions (planner rulings; owner confirmed the three below on 2026-10-09)

Owner answers, 2026-10-09: (a) when the feed is not Live, screens fall back to today's cadences (quote 3 s, depth 2 s, indices/watchlist 5 s, chart 20 s), served from the hub; (b) the owner's browser receives every hub price, not only on-screen ones; (c) exchange-less refs from cached tabs are treated as NSE for one release, then the fallback is removed.

1. **Personal MVP now, built to scale: the same one seam.** `hubFor(userId, 'browser')` is the only
   place that decides who is hub-served. Today: the owner, when the hub runs and `HUB_SERVES_BROWSER` is
   on. Multi-tenant later: `hubFor` returns that user's own hub, and nothing in the gateway, the
   controller or the web app changes (the gateway already keeps one listener per user). User A's
   browser is never fed from user B's session.
2. **Other users stay on today's path.** Their sockets get `feed-source: 'legacy'`, their subscriptions
   go to `UserFeedManager` as today, their REST calls take the legacy branch, and their browser keeps
   every poll at today's cadence. The one change they see is the exchange fix (decision 6).
3. **Every task is TDD with full code.** The web app's existing test setup is Vitest in a **node
   environment with no DOM and no React renderer** (`apps/web/vite.config.ts`; see
   `useInstrumentQuote.spec.ts`, which renders hooks with `renderToStaticMarkup` because effects cannot
   run). No new test infrastructure is added. Instead, every decision a hook makes (poll or not, which
   tick matches, how a tick updates a quote or a depth ladder, which refs to subscribe) is a pure
   function in `apps/web/src/services/browser-feed.ts` with its own spec, and the socket service's
   ref-counting is tested with the fake-socket pattern of `websocket.connect-gate.spec.ts`. The hooks
   become thin wiring of those functions. Adding jsdom + Testing Library would be the minimal step if
   hook-level tests are wanted later; it is not needed for M4.

Deviations from the brief or the spec text, with reasons:

4. **Polls are switched off, not deleted.** The spec says "browser 2–3 s polls removed". A hub-served
   browser makes no periodic call while its feed is Live; the same code polls at today's cadence when the
   feed is not Live (socket down or no tick for 6 s) and for every legacy user. Deleting the polls would
   break decision 2 and leave a hub-served page frozen during a socket stall. The REST endpoints those
   fallback polls hit are themselves hub-first, so a fallback poll costs no broker call while the hub
   has a fresh price.
5. **`Price` gains `day` and `depth`.** Spec §5.3 lists `bid?`/`ask?`. A quote needs the previous close
   (for change and change %), and the depth card needs five levels, so the hub carries
   `day: { open, high, low, close }` and `depth: { bids, asks }` (5 levels, which subsumes bid/ask).
   Both come from data the session already receives: SNAP_QUOTE ticks (`best_5_buy_data`,
   `best_5_sell_data`, `close_price`) and FULL quotes (`depth.buy/sell`, `close`). A zero day bar or an
   empty ladder means "not reported" and is left off, so a price without them is exactly M3's.
6. **The exchange fix is not behind the switch.** The client sends `refs: [{ token, exchange, symbol }]`.
   A bare token from an old cached bundle still means NSE (counted and logged at debug) so a stale tab
   keeps working for one release; an `EXCHANGE:token` string is also accepted. Unknown exchanges and
   non-numeric tokens are dropped. The legacy tick coalescing key becomes `EXCHANGE:token` too (it was the
   token alone). These are bug fixes for every user; only a code revert undoes them.
7. **`HubPrices.unwatch(refs, owner)` is added** (spec §3.1 has `unwatch`; M3's `HubPrices` did not
   expose it). Without it every abandoned chart symbol would hold a P4 watch, and its near-live polling,
   for the full 2-minute TTL.
8. **The owner's browser receives every hub price, not only what it subscribed.** That includes the
   owner's positions (P0), their underlyings (P1), the market context (P2) and strategy-track tokens
   (P3). It is the owner's own data on the owner's own session, it keeps the badge Live whatever page is
   open, and it gives the positions screens live prices with no subscription. Volume is bounded by the
   watched set (cap 50 live + near-live) and coalesced to at most 10 updates/s per instrument.
9. **`'browser'` refuses `userId === null`.** M3 lets `null` mean the system-wide paper tracks. A
   browser always has a user, so a `null` here is a bug and gets the legacy path.
10. **`hub.consumers.browser` counts REST answers only** (`hub` = served from the PriceBook, `legacy` =
    fell back), for hub-served users only (M3 decision 10). Socket pushes are not counted: the client's
    own `POST /healthz/client-report` stall reports are the evidence for the badge.
11. **Where the code differs from the spec's picture, the code wins.** `UserFeedSession` already maps
    NFO/BFO to their exchange types (spec §1.7 predates that fix); the remaining exchange bug is the
    gateway's. The web app has only one tick subscriber (`useChartData`); quote, depth, indices and
    watchlist never subscribed and polled instead.

## Global Constraints

- **Flag:** `HUB_SERVES_BROWSER` (config `hub.servesBrowser`), default **false**, needs
  `MARKET_HUB_ENABLED=true` and `HUB_OWNER_USER_ID`. With it off, every user's behaviour is M3's plus the
  exchange fix (decision 6).
- **The `hubFor` rule:** `hubFor(userId, 'browser')` serves `userId === HUB_OWNER_USER_ID` only. Every
  hub-served path (socket and REST) asks `hubFor` with the request's own user; nothing caches a hub
  across users.
- **Priorities:** browser watches are **2** (`context`), **3** (`watchlist`), **4** (`chart`, the default
  for anything else); never 0 or 1. REST reads watch at 4 (quote, depth), 2 (indices), 3 (watchlist).
- **TTL:** every browser and REST watch carries **120 000 ms** (spec §3.1 "screens: 2 min"); sockets
  renew theirs every **60 000 ms**.
- **Freshness:** REST answers from the hub only when `fresh` at **15 000 ms** (spec §5.3 screens) or
  `market-closed` (last price, labelled by its `timestamp`). Depth is served only when `fresh`.
  Anything else falls back to that endpoint's legacy path, per instrument. A hub miss never becomes a
  price of 0.
- **Instrument keys:** every map, cache, coalescing key and tick match is **exchange + token**.
- **Bounded memory:** at most **100** hub watches per socket; one hub listener per hub-served user,
  removed with that user's last socket; pending ticks ≤ distinct (user, instrument) pairs, cleared every
  100 ms flush; the web socket service's subscription map ≤ distinct refs the page asked for.
- **Boot must not block:** the gateway resolves the hub lazily on the first connection; nothing awaits
  the hub. `hub.watch`/`hub.unwatch` are never awaited on a request path.
- **Only door:** `KNOWN_VIOLATORS` in `only-door.spec.ts` must not grow. No new broker market-data call
  outside `modules/market-hub/`.
- **Commits:** explicit pathspecs (`git commit -- <paths>`), never a bare `git commit` or `-a`. Every
  message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **A non-owner user is never fed from the owner's hub** (socket or REST). (Task 1 test 'hubFor(…,
   "browser") serves only the owner, only with HUB_SERVES_BROWSER on, and never a null user'; Task 5
   test "a non-owner never reads the owner hub: legacy feed-source, manager subscribe with the right
   exchange, legacy ticks"; Task 6 test "serves nothing for a user hubFor does not serve, and counts
   nothing".)
2. **The same token on two exchanges.** NSE cash, NFO and MCX tokens collide; a price for one must never
   reach the other's row, chart or coalescing slot. (Task 3 test "parseFeedRefs keeps the same token on
   two exchanges as two refs"; Task 4 test "coalesces per EXCHANGE:token: the same token on two
   exchanges is two ticks"; Task 5 test "pushes every hub price to the owner room only, coalesced per
   EXCHANGE:token, as a Quote-compatible tick"; Task 6 test "keys answers by EXCHANGE:token, so the same
   token on two exchanges is priced separately"; Task 7 test "tickMatches needs the exchange to agree
   when the tick has one".)
3. **The badge must stay honest.** Polls switch off only while the feed is hub-served AND Live, and come
   back the moment it is not. (Task 7 tests "livePollMs is off only for a hub-served, Live feed" and
   "replays every subscription, grouped by purpose, when /ws reconnects"; Task 9 test "tickOpensGap
   is true only for a tick two or more bars past the last bar".)
4. **The hub cannot answer** (not running, flag off, lookup throws, never-priced, stale): every path
   takes its legacy branch, and nothing becomes "price 0" or "no depth" because the hub was empty.
   (Task 5 test "no hub in this container (lookup throws or no ModuleRef) is the legacy path"; Task 6
   tests "a never-priced or stale instrument is missing (legacy), and a market-closed one is served with
   its own timestamp" and "never throws: a throwing hubFor or price() means every ref is missing";
   Task 6 test "the hub tier answers first and only the misses reach the resolver".)
5. **Subscriptions do not leak.** Unsubscribe, symbol switch and disconnect release the hub watch; a
   socket cannot hold more than 100; the web client ref-counts so one hook's release does not drop
   another hook's live symbol. (Task 5 tests "unsubscribe and disconnect unwatch that socket's refs;
   the listener goes with the user's last socket" and "a socket holds at most 100 hub watches"; Task 7
   test "ref-counts subscriptions: one emit per new ref, one unsubscribe when the last holder
   releases".)

---

## File Structure

| Path | Responsibility |
|---|---|
| Modify `apps/api/src/modules/market-hub/hub-prices.ts` | `HubConsumer` gains `'browser'`; `HubPrices.unwatch`; `engineHubPrices` maps it |
| Modify `apps/api/src/modules/market-hub/hub-engine.ts` | `unwatchMany`; `consumers.browser`; `flags.browser` |
| Modify `apps/api/src/modules/market-hub/market-hub.service.ts` | `hubFor(…, 'browser')` behind `hub.servesBrowser`, never for `null` |
| Modify `apps/api/src/modules/market-hub/hub.types.ts` | `DayBar`, `DepthLevel`, `PriceDepth`; `Price.day`, `Price.depth` |
| Create `apps/api/src/modules/market-hub/tick-extras.ts` | `tickExtras(tick)`: day bar + depth from a broker tick, absent when not reported |
| Modify `apps/api/src/modules/market-hub/live-feed.ts`, `quote-poller.ts` | carry `tickExtras` onto every price |
| Modify `apps/api/src/common/interfaces/broker-adapter.interface.ts` | `TickDepth`, `TickDepthLevel`; `TickData.depth?` |
| Create `apps/api/src/modules/market-data/utils/depth-levels.ts` | `depthFromSnapQuote`, `depthFromFullQuote` |
| Modify `apps/api/src/modules/market-data/services/user-feed-session.ts`, `user-historical.util.ts` | attach depth to WS ticks and FULL quotes |
| Create `apps/api/src/modules/market-hub/browser-feed.ts` | browser wire format (`BrowserTick`), `priceToQuote`, `priceToDepth`, `parseFeedRefs`, purposes → priorities, TTL/renew/age/cap constants |
| Create `apps/api/src/modules/market-hub/serve-browser.ts` | `serveQuotesFromHub`, `serveDepthFromHub`, `hubQuoteKey`, `REST_OWNER` |
| Modify `apps/api/src/modules/market-data/gateways/market-data.gateway.ts` | exchange-aware subscribe; `EXCHANGE:token` coalescing; hub path behind the switch |
| Modify `apps/api/src/modules/market-data/controllers/market-data.controller.ts` | quote, depth, indices, quotes hub-first |
| Modify `apps/api/src/modules/market-data/services/batch-quotes.service.ts` | optional hub tier before the resolver |
| Modify `apps/api/src/config/configuration.ts`, `deploy/env/api.env.example` | `HUB_SERVES_BROWSER` |
| Create `apps/web/src/services/browser-feed.ts` | `FeedRef`, `feedKey`, `WireTick`, `tickMatches`, `livePollMs`, `quoteFromTick`, `depthFromTick`, `quoteForItem`, `indexRefs` |
| Modify `apps/web/src/services/websocket.ts` | refs + purpose payload, ref-counted subscriptions, replay by purpose, `feed-source` |
| Modify `apps/web/src/stores/market-store.ts` | `feedSource` |
| Create `apps/web/src/hooks/useLivePollMs.ts` | store-backed `livePollMs` |
| Modify `apps/web/src/hooks/useInstrumentQuote.ts`, `useMarketDepth.ts`, `useMarketData.ts`, `useWatchlistQuotes.ts` | ticks first; poll only as fallback |
| Modify `apps/web/src/hooks/useChartData.ts`, `useLiveRefresh.ts`, `apps/web/src/utils/chartSeries.ts` | exchange-aware subscribe; live edge from ticks; gap-triggered refresh |

---

### Task 1: The seam: `'browser'` consumer, `HUB_SERVES_BROWSER`, `unwatch`, counters

**Files:**
- Modify: `apps/api/src/modules/market-hub/hub-prices.ts`
- Modify: `apps/api/src/modules/market-hub/hub-engine.ts`
- Modify: `apps/api/src/modules/market-hub/hub-engine.spec.ts`
- Modify: `apps/api/src/modules/market-hub/market-hub.service.ts`
- Modify: `apps/api/src/modules/market-hub/market-hub.service.spec.ts`
- Modify: `apps/api/src/modules/trade-sentinel/adapters/tick-source.adapter.spec.ts` (its typed `HubPrices` fake gains `unwatch`)
- Modify: `apps/api/src/config/configuration.ts`
- Modify: `deploy/env/api.env.example`

**Interfaces:**
- Consumes: `HubEngine`, `WatchRegistry` (M1), `HubPriceSource`/`HubPrices`/`engineHubPrices` (M3).
- Produces:

```typescript
// hub-prices.ts
export type HubConsumer = 'positions' | 'tracks' | 'browser';
HubPrices.unwatch(refs: readonly InstrumentRef[], owner: string): Promise<void>   // never rejects
engineHubPrices(engine: Pick<HubEngine, 'price' | 'prices' | 'watchMany' | 'unwatchMany' | 'onPrice'>): HubPrices

// hub-engine.ts
export interface ConsumerFlags { positions: boolean; tracks: boolean; browser: boolean }
HubStatus.consumers: { positions; tracks; browser: ConsumerCounters; listenerErrors: number; flags: ConsumerFlags }
HubEngine.unwatchMany(refs: readonly InstrumentRef[], owner: string): Promise<void>   // never rejects

// market-hub.service.ts
MarketHubService.hubFor(userId: string | null, consumer: HubConsumer): HubPrices | null   // 'browser': owner only, never null
// config: hub.servesBrowser  (HUB_SERVES_BROWSER)
```

- [ ] **Step 1: Write the failing tests**

Append inside `describe('HubEngine', …)` in `hub-engine.spec.ts`:

```typescript
  it('unwatchMany drops one owner’s watches and reconciles once; another owner keeps the instrument live', async () => {
    const { e, broker } = engine();
    await e.start();
    const A: InstrumentRef = { exchange: 'NSE', token: '2885', symbol: 'RELIANCE' };
    await e.watchMany([A], 4, 'browser:s1', 120_000);
    await e.watchMany([A], 3, 'browser:s2', 120_000);
    await e.unwatchMany([A], 'browser:s1');
    expect(broker.subscribed.has('NSE:2885')).toBe(true);
    await e.unwatchMany([A], 'browser:s2');
    expect(broker.subscribed.has('NSE:2885')).toBe(false);
    expect(e.price(A, { maxAgeMs: 15_000 })).toEqual({ kind: 'unavailable', reason: 'not-watched' });
    e.stop();
  });

  it('unwatchMany never rejects when the broker is down', async () => {
    const broker = new FakeBroker();
    const { e } = engine(broker);
    await e.start();
    const A: InstrumentRef = { exchange: 'NSE', token: '2885', symbol: 'RELIANCE' };
    await e.watchMany([A], 4, 'browser:s1');
    broker.unsubscribe = async () => {
      throw new Error('socket closed');
    };
    await expect(e.unwatchMany([A], 'browser:s1')).resolves.toBeUndefined();
    expect(e.status().lastError).toMatch(/socket closed/);
    e.stop();
  });

  it('counts browser outcomes apart from positions and tracks', async () => {
    const { e } = engine();
    await e.start();
    e.recordConsumer('browser', 'hub', 4);
    e.recordConsumer('browser', 'legacy');
    expect(e.status().consumers.browser).toEqual({ hub: 4, legacy: 1, unpriced: 0, lastHubAt: Date.now(), lastUnpricedAt: null });
    expect(e.status().consumers.positions.hub).toBe(0);
    e.stop();
  });
```

In the same file, in the existing test `counts consumer outcomes per consumer and stamps the last hub-served and unpriced times`, replace the expected object with:

```typescript
    expect(e.status().consumers).toEqual({
      positions: { hub: 3, legacy: 1, unpriced: 0, lastHubAt: Date.now(), lastUnpricedAt: null },
      tracks: { hub: 0, legacy: 0, unpriced: 2, lastHubAt: null, lastUnpricedAt: Date.now() },
      browser: { hub: 0, legacy: 0, unpriced: 0, lastHubAt: null, lastUnpricedAt: null },
      listenerErrors: 0,
      flags: { positions: false, tracks: false, browser: false }, // no consumerFlags dep: every switch reads as off
    });
```

Append inside `describe('MarketHubService', …)` in `market-hub.service.spec.ts`, after the `enabled` helper:

```typescript
  it('hubFor(…, "browser") serves only the owner, only with HUB_SERVES_BROWSER on, and never a null user', () => {
    const on = new MarketHubService(enabled({ 'hub.servesBrowser': true }) as any, manager() as any, tracker as any, prisma as any, runner as any, instruments as any);
    on.onModuleInit();
    expect(on.hubFor('owner', 'browser')).not.toBeNull();
    // Never another user's browser from the owner's session.
    expect(on.hubFor('someone-else', 'browser')).toBeNull();
    // A browser always has a user: null is a bug, and gets the legacy path.
    expect(on.hubFor(null, 'browser')).toBeNull();
    // The other consumers keep their own switches.
    expect(on.hubFor('owner', 'positions')).toBeNull();
    on.onModuleDestroy();

    const off = new MarketHubService(enabled({ 'hub.pricesPositions': true }) as any, manager() as any, tracker as any, prisma as any, runner as any, instruments as any);
    off.onModuleInit();
    expect(off.hubFor('owner', 'browser')).toBeNull();
    off.onModuleDestroy();
  });

  it('the browser hub can unwatch, and its outcomes land in status().consumers.browser', async () => {
    const svc = new MarketHubService(enabled({ 'hub.servesBrowser': true }) as any, manager() as any, tracker as any, prisma as any, runner as any, instruments as any);
    svc.onModuleInit();
    const hub = svc.hubFor('owner', 'browser')!;
    const ref = { exchange: 'NFO' as const, token: '35001', symbol: 'NIFTY26OCT25000CE' };
    void hub.watch([ref], 4, 'browser:s1', 120_000);
    expect(hub.price(ref, { maxAgeMs: 15_000 })).toEqual({ kind: 'unavailable', reason: 'never-priced' });
    await expect(hub.unwatch([ref], 'browser:s1')).resolves.toBeUndefined();
    expect(hub.price(ref, { maxAgeMs: 15_000 })).toEqual({ kind: 'unavailable', reason: 'not-watched' });
    svc.record('browser', 'hub', 2);
    expect(svc.status()?.consumers.browser.hub).toBe(2);
    expect(svc.status()?.consumers.flags.browser).toBe(true);
    svc.onModuleDestroy();
  });
```

In the existing test `status().consumers.flags reflects the two consumer switches, …`, change the two expectations to:

```typescript
    expect(svc.status()?.consumers.flags).toEqual({ positions: true, tracks: false, browser: false });
```

and

```typescript
    expect(other.status()?.consumers.flags).toEqual({ positions: false, tracks: true, browser: false });
```

In `trade-sentinel/adapters/tick-source.adapter.spec.ts`, inside `hubWith`, add to the `hub: HubPrices` literal after the `watch:` line:

```typescript
    unwatch: jest.fn().mockResolvedValue(undefined),
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @td/api test -- hub-engine.spec market-hub.service.spec`
Expected: FAIL. `e.unwatchMany is not a function`; `Cannot read properties of undefined (reading 'hub')` for `consumers.browser`; the flags `toEqual` misses `browser`; `hubFor('owner', 'browser')` is `null` (no such switch yet); `hub.unwatch is not a function`.

- [ ] **Step 3: Implement**

In `hub-prices.ts`:
- replace the `HubConsumer` declaration and its comment with:

```typescript
/** Which consumer switch a caller sits behind: HUB_PRICES_POSITIONS, HUB_PRICES_TRACKS or HUB_SERVES_BROWSER. */
export type HubConsumer = 'positions' | 'tracks' | 'browser';
```

- in `interface HubPrices`, after the `watch(…)` member, add:

```typescript
  /** Drop `owner`'s watch on every ref, then reconcile once. Never rejects (status().lastError). */
  unwatch(refs: readonly InstrumentRef[], owner: string): Promise<void>;
```

- replace `engineHubPrices` with:

```typescript
/** One engine's prices, as the HubPrices a consumer sees. */
export function engineHubPrices(
  engine: Pick<HubEngine, 'price' | 'prices' | 'watchMany' | 'unwatchMany' | 'onPrice'>,
): HubPrices {
  return {
    price: (ref, opts) => engine.price(ref, opts),
    prices: (refs, opts) => engine.prices(refs, opts),
    watch: (refs, priority, owner, ttlMs) => engine.watchMany(refs, priority, owner, ttlMs),
    unwatch: (refs, owner) => engine.unwatchMany(refs, owner),
    onPrice: (fn) => engine.onPrice(fn),
  };
}
```

In `hub-engine.ts`:
- replace `interface ConsumerFlags` with:

```typescript
/** The consumer switches, so /healthz/detail tells "hub served 0" apart from "switch off". */
export interface ConsumerFlags {
  positions: boolean;
  tracks: boolean;
  browser: boolean;
}
```

- in `HubStatus`, replace the `consumers:` line with:

```typescript
  /** M3/M4: per consumer, how often the hub served, the legacy path served, or nothing did. */
  consumers: {
    positions: ConsumerCounters;
    tracks: ConsumerCounters;
    browser: ConsumerCounters;
    listenerErrors: number;
    flags: ConsumerFlags;
  };
```

- in the `consumerCounts` initialiser, after the `tracks:` line, add:

```typescript
    browser: { hub: 0, legacy: 0, unpriced: 0, lastHubAt: null, lastUnpricedAt: null },
```

- after `watchMany`, add:

```typescript
  /** Drop one owner's watches, then reconcile once. Never rejects (the failure is in status().lastError). */
  async unwatchMany(refs: readonly InstrumentRef[], owner: string): Promise<void> {
    for (const r of refs) this.registry.unwatch(r, owner);
    await this.reconcileSafely();
  }
```

- in `status()`, replace the `consumers: { … }` block with:

```typescript
      consumers: {
        positions: { ...this.consumerCounts.positions },
        tracks: { ...this.consumerCounts.tracks },
        browser: { ...this.consumerCounts.browser },
        listenerErrors: this.listenerErrors,
        flags: this.d.consumerFlags?.() ?? { positions: false, tracks: false, browser: false },
      },
```

- in `HubEngineDeps`, change the `consumerFlags` comment to `/** The consumer switches, read at status time. Absent ⇒ all off. */`.

In `market-hub.service.ts`:
- in the `HubEngine` construction, replace the `consumerFlags` property with:

```typescript
      consumerFlags: () => ({
        positions: this.consumerEnabled('positions'),
        tracks: this.consumerEnabled('tracks'),
        browser: this.consumerEnabled('browser'),
      }),
```

- replace `hubFor` and `consumerEnabled` with:

```typescript
  /**
   * See HubPriceSource.hubFor. Personal MVP: only the owner's hub exists.
   * `null` means the system-wide paper tracks; a browser always has a user, so
   * 'browser' never serves null.
   */
  hubFor(userId: string | null, consumer: HubConsumer): HubPrices | null {
    if (!this.engine || !this.ownerHub || !this.ownerUserId) return null;
    if (!this.consumerEnabled(consumer)) return null;
    if (userId === null && consumer === 'browser') return null;
    if (userId !== null && userId !== this.ownerUserId) return null;
    return this.ownerHub;
  }
```

```typescript
  private consumerEnabled(consumer: HubConsumer): boolean {
    return this.config.get<boolean>(CONSUMER_FLAG[consumer]) === true;
  }
```

- below the `MAX_UNDERLYING_CACHE` constant, add:

```typescript
/** The config key behind each consumer switch. */
const CONSUMER_FLAG: Record<HubConsumer, string> = {
  positions: 'hub.pricesPositions',
  tracks: 'hub.pricesTracks',
  browser: 'hub.servesBrowser',
};
```

- in the class doc comment, after the M3 sentence, add: `M4: feeds the owner's browser (the /ws gateway and the quote, depth, indices and watchlist endpoints) behind HUB_SERVES_BROWSER.`

In `config/configuration.ts`, after the line `pricesTracks: process.env.HUB_PRICES_TRACKS === 'true',` add:

```typescript
    // M4 consumer switch: the owner's browser is fed by the hub (/ws ticks + quote, depth,
    // indices and watchlist endpoints) and stops polling while Live. Off = legacy path.
    servesBrowser: process.env.HUB_SERVES_BROWSER === 'true',
```

In `deploy/env/api.env.example`, after the line `HUB_PRICES_TRACKS=false` add:

```
# SP1 M4 switch (needs MARKET_HUB_ENABLED=true): YOUR browser is fed by the hub and stops polling while Live.
HUB_SERVES_BROWSER=false
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @td/api test -- hub-engine.spec market-hub.service.spec tick-source.adapter.spec exit-price.service.spec trade-tracker-poller.service.spec`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/market-hub/hub-prices.ts apps/api/src/modules/market-hub/hub-engine.ts apps/api/src/modules/market-hub/hub-engine.spec.ts apps/api/src/modules/market-hub/market-hub.service.ts apps/api/src/modules/market-hub/market-hub.service.spec.ts apps/api/src/modules/trade-sentinel/adapters/tick-source.adapter.spec.ts apps/api/src/config/configuration.ts deploy/env/api.env.example
git commit -m "feat(market-hub): browser consumer behind HUB_SERVES_BROWSER, hub unwatch, browser counters" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/market-hub/hub-prices.ts apps/api/src/modules/market-hub/hub-engine.ts apps/api/src/modules/market-hub/hub-engine.spec.ts apps/api/src/modules/market-hub/market-hub.service.ts apps/api/src/modules/market-hub/market-hub.service.spec.ts apps/api/src/modules/trade-sentinel/adapters/tick-source.adapter.spec.ts apps/api/src/config/configuration.ts deploy/env/api.env.example
```

---

### Task 2: Day bar and depth on ticks and hub prices

**Files:**
- Modify: `apps/api/src/common/interfaces/broker-adapter.interface.ts`
- Create: `apps/api/src/modules/market-data/utils/depth-levels.ts`
- Create: `apps/api/src/modules/market-data/utils/depth-levels.spec.ts`
- Modify: `apps/api/src/modules/market-data/services/user-feed-session.ts`
- Modify: `apps/api/src/modules/market-data/services/user-feed-session.spec.ts`
- Modify: `apps/api/src/modules/market-data/services/user-historical.util.ts`
- Modify: `apps/api/src/modules/market-data/services/user-historical.util.spec.ts`
- Modify: `apps/api/src/modules/market-hub/hub.types.ts`
- Create: `apps/api/src/modules/market-hub/tick-extras.ts`
- Modify: `apps/api/src/modules/market-hub/live-feed.ts`
- Modify: `apps/api/src/modules/market-hub/live-feed.spec.ts`
- Modify: `apps/api/src/modules/market-hub/quote-poller.ts`
- Modify: `apps/api/src/modules/market-hub/quote-poller.spec.ts`

**Interfaces:**
- Consumes: `TickData` (broker-adapter interface), `UserFeedSession.mapSingleTick` (private), `mapFullQuote`, `LiveFeed.onTick`, `QuotePoller.apply`.
- Produces:

```typescript
// broker-adapter.interface.ts
export interface TickDepthLevel { price: number; qty: number; orders: number }
export interface TickDepth { bids: TickDepthLevel[]; asks: TickDepthLevel[] }
TickData.depth?: TickDepth      // absent when the broker reported no level

// market-data/utils/depth-levels.ts
export const DEPTH_LEVELS = 5;
export function depthFromSnapQuote(tick: unknown, paiseDivisor: number): TickDepth | undefined;
export function depthFromFullQuote(node: unknown): TickDepth | undefined;

// hub.types.ts
export interface DayBar { open: number; high: number; low: number; close: number }  // close = previous session close
export interface DepthLevel { price: number; qty: number; orders: number }
export interface PriceDepth { bids: DepthLevel[]; asks: DepthLevel[] }
Price.day?: DayBar
Price.depth?: PriceDepth

// tick-extras.ts
export function tickExtras(t: TickData): Pick<Price, 'day' | 'depth'>;   // {} when neither was reported
```

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/modules/market-data/utils/depth-levels.spec.ts`:

```typescript
import { depthFromFullQuote, depthFromSnapQuote } from './depth-levels';

describe('depthFromSnapQuote (WebSocketV2 SNAP_QUOTE)', () => {
  it('maps the best-five arrays from paise to rupees, keeping at most five levels and dropping empty ones', () => {
    const tick = {
      best_5_buy_data: [
        { flag: 1, quantity: 75, price: 25005, no_of_orders: 3 },
        { flag: 1, quantity: 150, price: 25000, no_of_orders: 5 },
        { flag: 1, quantity: 0, price: 0, no_of_orders: 0 },
      ],
      best_5_sell_data: [
        { flag: 0, quantity: 50, price: 25010, no_of_orders: 2 },
        ...Array.from({ length: 6 }, (_, i) => ({ flag: 0, quantity: 1, price: 25020 + i, no_of_orders: 1 })),
      ],
    };
    const d = depthFromSnapQuote(tick, 100)!;
    expect(d.bids).toEqual([
      { price: 250.05, qty: 75, orders: 3 },
      { price: 250, qty: 150, orders: 5 },
    ]);
    expect(d.asks).toHaveLength(5);
    expect(d.asks[0]).toEqual({ price: 250.1, qty: 50, orders: 2 });
  });

  it('is undefined when the tick carries no level at all (LTP/QUOTE mode, indices)', () => {
    expect(depthFromSnapQuote({ last_traded_price: 100 }, 100)).toBeUndefined();
    expect(depthFromSnapQuote({ best_5_buy_data: [{ price: 0, quantity: 0 }], best_5_sell_data: [] }, 100)).toBeUndefined();
    expect(depthFromSnapQuote(null, 100)).toBeUndefined();
  });
});

describe('depthFromFullQuote (REST marketData FULL)', () => {
  it('maps depth.buy / depth.sell in rupees', () => {
    const d = depthFromFullQuote({
      depth: {
        buy: [{ price: 1500.5, quantity: 10, orders: 2 }],
        sell: [{ price: 1501, quantity: 7, orders: 1 }],
      },
    })!;
    expect(d).toEqual({ bids: [{ price: 1500.5, qty: 10, orders: 2 }], asks: [{ price: 1501, qty: 7, orders: 1 }] });
  });

  it('falls back through the SDK’s camel-cased shapes, and is undefined with no levels', () => {
    expect(depthFromFullQuote({ bestBids: [{ Price: 99, Quantity: 1, NoOfOrders: 1 }], bestAsks: [] })).toEqual({
      bids: [{ price: 99, qty: 1, orders: 1 }],
      asks: [],
    });
    expect(depthFromFullQuote({ ltp: 5 })).toBeUndefined();
  });
});
```

Append to `user-feed-session.spec.ts` (top level, next to `stamps each tick with its exchange from exchange_type`):

```typescript
it('carries SNAP_QUOTE best-five depth on the tick, in rupees', async () => {
  const { s, d } = makeSession();
  const ticks: any[] = [];
  s.onTick((t) => ticks.push(t));
  await s.ensureConnected();
  d.ws.handlers.tick({
    token: '"2885"',
    exchange_type: 1,
    last_traded_price: 150050,
    close_price: 149000,
    best_5_buy_data: [{ flag: 1, quantity: 10, price: 150040, no_of_orders: 2 }],
    best_5_sell_data: [{ flag: 0, quantity: 4, price: 150060, no_of_orders: 1 }],
  });
  expect(ticks[0]).toMatchObject({
    token: '2885',
    exchange: 'NSE',
    ltp: 1500.5,
    close: 1490,
    depth: { bids: [{ price: 1500.4, qty: 10, orders: 2 }], asks: [{ price: 1500.6, qty: 4, orders: 1 }] },
  });
});

it('a tick with no best-five data has no depth field', async () => {
  const { s, d } = makeSession();
  const ticks: any[] = [];
  s.onTick((t) => ticks.push(t));
  await s.ensureConnected();
  d.ws.handlers.tick({ token: '"99926000"', exchange_type: 1, last_traded_price: 2500000 });
  expect(ticks[0]).not.toHaveProperty('depth');
});
```

Append inside `describe('mapFullQuote', …)` in `user-historical.util.spec.ts`:

```typescript
    it('carries the FULL depth when the broker sends one, and has no depth field otherwise', () => {
      const withDepth = mapFullQuote(
        [{ symbolToken: '2885', ltp: 1500.5, close: 1495, depth: { buy: [{ price: 1500.4, quantity: 3, orders: 1 }], sell: [] } }],
        '2885',
      );
      expect(withDepth!.depth).toEqual({ bids: [{ price: 1500.4, qty: 3, orders: 1 }], asks: [] });
      const without = mapFullQuote([{ symbolToken: '2885', ltp: 1500.5 }], '2885');
      expect(without).not.toHaveProperty('depth');
    });
```

In `live-feed.spec.ts`, change the import `import { refKey, type InstrumentRef } from './hub.types';` to `import { refKey, type InstrumentRef, type Price } from './hub.types';`, then append inside `describe('LiveFeed', …)`:

```typescript
  it('carries a tick’s day bar and depth onto the price; a tick that reports neither carries neither', async () => {
    const { broker, registry, feed } = setup();
    registry.watch(ref('2885'), 4, 'browser:s1', 0);
    await feed.reconcile();
    const seen: Price[] = [];
    feed.onPrice((p) => seen.push(p));
    broker.emitTick({
      ...FakeBroker.tick('2885', 1500.5, 'NSE'),
      open: 1490,
      high: 1502,
      low: 1488,
      close: 1495,
      depth: { bids: [{ price: 1500.4, qty: 3, orders: 1 }], asks: [] },
    });
    broker.emitTick(FakeBroker.tick('2885', 1501, 'NSE'));
    expect(seen[0].day).toEqual({ open: 1490, high: 1502, low: 1488, close: 1495 });
    expect(seen[0].depth).toEqual({ bids: [{ price: 1500.4, qty: 3, orders: 1 }], asks: [] });
    expect(seen[1]).not.toHaveProperty('day');
    expect(seen[1]).not.toHaveProperty('depth');
  });
```

Append inside `describe('QuotePoller', …)` in `quote-poller.spec.ts` (`FakeBroker` and `Price` are already imported there):

```typescript
  it('carries the quote’s day bar and depth onto the polled price', async () => {
    const seen: Price[] = [];
    const { broker, registry, feed, poller } = await setup(0, (p) => seen.push(p));
    broker.quoteImpl = async (refs) =>
      new Map(
        refs.map((r) => [
          r.token,
          { ...FakeBroker.tick(r.token, 100), open: 98, high: 101, low: 97, close: 99, depth: { bids: [], asks: [{ price: 100.05, qty: 5, orders: 1 }] } },
        ]),
      );
    registry.watch(ref('1'), 3, 'w', 0);
    await feed.reconcile();
    poller.pollNearLive();
    await jest.advanceTimersByTimeAsync(200);
    expect(seen[0]).toMatchObject({
      source: 'quote',
      day: { open: 98, high: 101, low: 97, close: 99 },
      depth: { bids: [], asks: [{ price: 100.05, qty: 5, orders: 1 }] },
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @td/api test -- depth-levels.spec user-feed-session.spec user-historical.util.spec live-feed.spec quote-poller.spec`
Expected: FAIL. `Cannot find module './depth-levels'`; the session tick has no `depth`; `withDepth!.depth` is `undefined`; `seen[0].day` is `undefined` in both hub specs.

- [ ] **Step 3: Implement**

In `common/interfaces/broker-adapter.interface.ts`, above `export interface TickData`, add:

```typescript
/** One level of the order book, in rupees. */
export interface TickDepthLevel {
  price: number;
  qty: number;
  orders: number;
}

/** Up to five levels a side, best first. */
export interface TickDepth {
  bids: TickDepthLevel[];
  asks: TickDepthLevel[];
}
```

and inside `TickData`, after the `exchange?` member, add:

```typescript
  /** Best-five order book (SNAP_QUOTE ticks, FULL quotes). Absent when the broker reported no level. */
  depth?: TickDepth;
```

Create `apps/api/src/modules/market-data/utils/depth-levels.ts`:

```typescript
import type { TickDepth, TickDepthLevel } from '../../../common/interfaces/broker-adapter.interface';

/** Angel One reports five levels a side in SNAP_QUOTE and FULL. */
export const DEPTH_LEVELS = 5;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function levels(raw: unknown, toLevel: (l: any) => TickDepthLevel): TickDepthLevel[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, DEPTH_LEVELS)
    .map(toLevel)
    .filter((l) => l.price > 0);
}

/** No level on either side means "not reported" (LTP/QUOTE mode, indices), never an empty book. */
function pack(bids: TickDepthLevel[], asks: TickDepthLevel[]): TickDepth | undefined {
  return bids.length === 0 && asks.length === 0 ? undefined : { bids, asks };
}

/**
 * WebSocketV2 SNAP_QUOTE (smartapi-javascript `websocket2.0.js`): `best_5_buy_data` /
 * `best_5_sell_data`, each `{ flag, quantity, price, no_of_orders }`, prices in paise.
 */
export function depthFromSnapQuote(tick: unknown, paiseDivisor: number): TickDepth | undefined {
  const t = tick as { best_5_buy_data?: unknown; best_5_sell_data?: unknown } | null | undefined;
  const toLevel = (l: any): TickDepthLevel => ({
    price: num(l?.price) / paiseDivisor,
    qty: num(l?.quantity),
    orders: num(l?.no_of_orders),
  });
  return pack(levels(t?.best_5_buy_data, toLevel), levels(t?.best_5_sell_data, toLevel));
}

/**
 * REST `marketData({ mode: 'FULL' })` entry: `depth.buy` / `depth.sell`, each
 * `{ price, quantity, orders }`, in rupees. Same key fallbacks as the shared
 * adapter's getMarketDepth (some SDK versions camel-case them).
 */
export function depthFromFullQuote(node: unknown): TickDepth | undefined {
  const n = node as any;
  const toLevel = (l: any): TickDepthLevel => ({
    price: num(l?.price ?? l?.Price),
    qty: num(l?.quantity ?? l?.qty ?? l?.Quantity),
    orders: num(l?.orders ?? l?.noOfOrders ?? l?.NoOfOrders),
  });
  const buy = n?.depth?.buy ?? n?.depth?.bestBids ?? n?.bestBids ?? n?.buy;
  const sell = n?.depth?.sell ?? n?.depth?.bestAsks ?? n?.bestAsks ?? n?.sell;
  return pack(levels(buy, toLevel), levels(sell, toLevel));
}
```

In `user-feed-session.ts`, add `import { depthFromSnapQuote } from '../utils/depth-levels';` with the other imports, and replace the whole `mapSingleTick` method with:

```typescript
  private mapSingleTick(tick: any): TickData | null {
    if (!tick) return null;

    // Token can arrive with extra quotes: "\"99926013\"" → strip them.
    const rawToken = String(tick.token ?? tick.symbolToken ?? tick.tk ?? '');
    const token = rawToken.replace(/"/g, '');
    // SNAP_QUOTE carries the best five levels a side; absent in other modes and for indices.
    const depth = depthFromSnapQuote(tick, PAISE_DIVISOR);

    return {
      token,
      symbol: String(tick.symbol ?? tick.tradingSymbol ?? tick.name ?? ''),
      exchange: EXCHANGE_NAME_BY_TYPE[Number(tick.exchange_type ?? tick.exchangeType)],
      ltp: this.toNumber(tick.last_traded_price ?? tick.ltp ?? tick.lp ?? 0) / PAISE_DIVISOR,
      open:
        this.toNumber(
          tick.open_price_day ?? tick.open_price_of_the_day ?? tick.open ?? tick.op ?? 0,
        ) / PAISE_DIVISOR,
      high:
        this.toNumber(
          tick.high_price_day ?? tick.high_price_of_the_day ?? tick.high ?? tick.hp ?? 0,
        ) / PAISE_DIVISOR,
      low:
        this.toNumber(
          tick.low_price_day ?? tick.low_price_of_the_day ?? tick.low ?? tick.lop ?? 0,
        ) / PAISE_DIVISOR,
      close:
        this.toNumber(tick.close_price ?? tick.closed_price ?? tick.close ?? tick.cp ?? 0) /
        PAISE_DIVISOR,
      volume: this.toNumber(
        tick.vol_traded ?? tick.volume_trade_for_the_day ?? tick.volume ?? tick.v ?? 0,
      ),
      oi: tick.open_interest ? this.toNumber(tick.open_interest) : undefined,
      timestamp: tick.exchange_timestamp
        ? new Date(Number(tick.exchange_timestamp))
        : new Date(),
      ...(depth ? { depth } : {}),
    };
  }
```

In `user-historical.util.ts`, add `import { depthFromFullQuote } from '../utils/depth-levels';` with the other imports, and replace `mapFullQuote` with:

```typescript
export function mapFullQuote(fetched: any, token: string): TickData | null {
  if (!Array.isArray(fetched) || fetched.length === 0) return null;
  const d = fetched[0];
  const depth = depthFromFullQuote(d);
  return {
    token: String(d.symbolToken ?? d.symboltoken ?? token),
    symbol: d.tradingSymbol ?? d.tradingsymbol ?? '',
    ltp: Number(d.ltp),
    open: Number(d.open ?? 0),
    high: Number(d.high ?? 0),
    low: Number(d.low ?? 0),
    close: Number(d.close ?? 0),
    volume: Number(d.tradeVolume ?? d.volume),
    oi: d.opnInterest != null ? Number(d.opnInterest) : undefined,
    timestamp: new Date(),
    ...(depth ? { depth } : {}),
  };
}
```

In `hub.types.ts`, above `export interface Price`, add:

```typescript
/** The session's day bar as the broker reports it. `close` is the PREVIOUS session's close. */
export interface DayBar {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface DepthLevel {
  price: number;
  qty: number;
  orders: number;
}

/** Up to five levels a side, best first, in rupees. */
export interface PriceDepth {
  bids: DepthLevel[];
  asks: DepthLevel[];
}
```

and inside `Price`, after `oi?: number;`, add:

```typescript
  /** M4: day bar (for change vs the previous close). Absent when the broker reported none. */
  day?: DayBar;
  /** M4: best-five book. Absent when the broker reported no level. */
  depth?: PriceDepth;
```

Create `apps/api/src/modules/market-hub/tick-extras.ts`:

```typescript
import type { TickData } from '../../common/interfaces/broker-adapter.interface';
import type { Price } from './hub.types';

function finite(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/**
 * What a hub price carries beyond the LTP: the day bar and the book. A field the
 * broker did not report is LEFT OFF (an all-zero day bar, an empty book), so a
 * consumer can never mistake "not reported" for a previous close of 0, which
 * would read as a -100 % day.
 */
export function tickExtras(t: TickData): Pick<Price, 'day' | 'depth'> {
  const out: Pick<Price, 'day' | 'depth'> = {};
  if (finite(t.close) > 0 || finite(t.open) > 0) {
    out.day = { open: finite(t.open), high: finite(t.high), low: finite(t.low), close: finite(t.close) };
  }
  if (t.depth && (t.depth.bids.length > 0 || t.depth.asks.length > 0)) {
    out.depth = { bids: t.depth.bids.map((l) => ({ ...l })), asks: t.depth.asks.map((l) => ({ ...l })) };
  }
  return out;
}
```

In `live-feed.ts`, add `import { tickExtras } from './tick-extras';`, and in `onTick` replace the `price` literal with:

```typescript
    const price: Price = {
      ref,
      ltp: t.ltp,
      at: Date.now(), // receipt time: the price is confirmed current NOW
      source: 'ws',
      volume: t.volume,
      oi: t.oi,
      ...tickExtras(t),
    };
```

In `quote-poller.ts`, add `import { tickExtras } from './tick-extras';`, and in `apply` replace the `price` literal with:

```typescript
      const price: Price = {
        ref,
        ltp: o.tick.ltp,
        at: Date.now(),
        source: 'quote',
        volume: o.tick.volume,
        oi: o.tick.oi,
        ...tickExtras(o.tick),
      };
```

- [ ] **Step 4: Run tests to verify they pass, including every existing hub and session spec**

Run: `pnpm --filter @td/api test -- depth-levels.spec user-feed-session.spec user-historical.util.spec user-quotes.util.spec live-feed.spec quote-poller.spec hub-engine.spec candle-builder.spec only-door.spec`
Expected: PASS. `FakeBroker.tick` reports an all-zero day and no book, so every existing `toEqual` on a `Price` is unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/common/interfaces/broker-adapter.interface.ts apps/api/src/modules/market-data/utils/depth-levels.ts apps/api/src/modules/market-data/utils/depth-levels.spec.ts apps/api/src/modules/market-data/services/user-feed-session.ts apps/api/src/modules/market-data/services/user-feed-session.spec.ts apps/api/src/modules/market-data/services/user-historical.util.ts apps/api/src/modules/market-data/services/user-historical.util.spec.ts apps/api/src/modules/market-hub/hub.types.ts apps/api/src/modules/market-hub/tick-extras.ts apps/api/src/modules/market-hub/live-feed.ts apps/api/src/modules/market-hub/live-feed.spec.ts apps/api/src/modules/market-hub/quote-poller.ts apps/api/src/modules/market-hub/quote-poller.spec.ts
git commit -m "feat(market-hub): carry the day bar and best-five depth from ticks and FULL quotes onto hub prices" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/common/interfaces/broker-adapter.interface.ts apps/api/src/modules/market-data/utils/depth-levels.ts apps/api/src/modules/market-data/utils/depth-levels.spec.ts apps/api/src/modules/market-data/services/user-feed-session.ts apps/api/src/modules/market-data/services/user-feed-session.spec.ts apps/api/src/modules/market-data/services/user-historical.util.ts apps/api/src/modules/market-data/services/user-historical.util.spec.ts apps/api/src/modules/market-hub/hub.types.ts apps/api/src/modules/market-hub/tick-extras.ts apps/api/src/modules/market-hub/live-feed.ts apps/api/src/modules/market-hub/live-feed.spec.ts apps/api/src/modules/market-hub/quote-poller.ts apps/api/src/modules/market-hub/quote-poller.spec.ts
```

---

### Task 3: The browser wire format and exchange-aware refs (`browser-feed.ts`)

**Files:**
- Create: `apps/api/src/modules/market-hub/browser-feed.ts`
- Create: `apps/api/src/modules/market-hub/browser-feed.spec.ts`

**Interfaces:**
- Consumes: `Price`, `PriceDepth`, `InstrumentRef`, `Priority`, `isHubExchange` (`hub.types.ts`, Task 2); `tickToQuote`, `QuoteResponse` (`market-data/utils/tick-to-quote.ts`); `TickData`.
- Produces (pure, no Nest, no I/O; safe to import from the market-data module):

```typescript
export const BROWSER_WATCH_TTL_MS = 120_000;
export const BROWSER_RENEW_MS = 60_000;
export const SCREEN_MAX_AGE_MS = 15_000;
export const MAX_BROWSER_REFS_PER_SOCKET = 100;
export type FeedPurpose = 'chart' | 'watchlist' | 'context';
export function browserPriority(purpose: unknown): Priority;           // context 2 · watchlist 3 · chart/other 4
export function browserOwner(socketId: string): string;                // 'browser:<socketId>'
export interface SubscribeBody { tokens?: unknown; refs?: unknown; purpose?: unknown }
export interface ParsedRefs { refs: InstrumentRef[]; bareTokens: number }
export function parseFeedRefs(body: SubscribeBody | null | undefined, cap?: number): ParsedRefs;
export interface BrowserTick extends TickData { exchange: string; at: number; source: Price['source']; change?: number; changePercent?: number }
export function priceToTickData(p: Price, symbol?: string): TickData;
export function priceToBrowserTick(p: Price): BrowserTick;
export function priceToQuote(p: Price, symbol?: string): QuoteResponse;
export function priceToDepth(p: Price): MarketDepth | null;            // MarketDepth from @td/shared/types
```

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/modules/market-hub/browser-feed.spec.ts`:

```typescript
import {
  MAX_BROWSER_REFS_PER_SOCKET,
  browserOwner,
  browserPriority,
  parseFeedRefs,
  priceToBrowserTick,
  priceToDepth,
  priceToQuote,
} from './browser-feed';
import type { Price } from './hub.types';

const AT = Date.parse('2026-10-12T04:00:00.000Z'); // 09:30 IST
const OPT: Price = {
  ref: { exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' },
  ltp: 121,
  at: AT,
  source: 'ws',
  volume: 9000,
  oi: 120_000,
  day: { open: 100, high: 125, low: 95, close: 110 },
  depth: { bids: [{ price: 120.95, qty: 75, orders: 3 }], asks: [{ price: 121.05, qty: 150, orders: 4 }] },
};

describe('parseFeedRefs', () => {
  it('takes the exchange the client sends (refs), upper-cased, with its symbol', () => {
    expect(parseFeedRefs({ refs: [{ token: '35001', exchange: 'nfo', symbol: 'NIFTY26OCT25000CE' }, { token: '2885', exchange: 'NSE' }] })).toEqual({
      refs: [
        { exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' },
        { exchange: 'NSE', token: '2885', symbol: '2885' },
      ],
      bareTokens: 0,
    });
  });

  it('keeps the same token on two exchanges as two refs, and drops exact duplicates', () => {
    const { refs } = parseFeedRefs({
      refs: [
        { token: '1594', exchange: 'NSE' },
        { token: '1594', exchange: 'MCX' },
        { token: '1594', exchange: 'nse' },
      ],
    });
    expect(refs.map((r) => `${r.exchange}:${r.token}`)).toEqual(['NSE:1594', 'MCX:1594']);
  });

  it('accepts EXCHANGE:token strings; a bare token (old client bundle) means NSE and is counted', () => {
    expect(parseFeedRefs({ tokens: ['MCX:4321', '2885'] })).toEqual({
      refs: [
        { exchange: 'MCX', token: '4321', symbol: '4321' },
        { exchange: 'NSE', token: '2885', symbol: '2885' },
      ],
      bareTokens: 1,
    });
  });

  it('drops unknown exchanges, non-numeric and zero tokens, and junk', () => {
    expect(parseFeedRefs({ tokens: ['CDS:1', 'abc', '0', 42, null], refs: undefined }).refs).toEqual([]);
    expect(parseFeedRefs({ refs: [{ token: '1', exchange: 'XYZ' }, { token: 7, exchange: 'NSE' }, null] }).refs).toEqual([]);
    expect(parseFeedRefs(null)).toEqual({ refs: [], bareTokens: 0 });
  });

  it('refs win over tokens when both are sent', () => {
    expect(parseFeedRefs({ tokens: ['111'], refs: [{ token: '35001', exchange: 'NFO' }] }).refs).toEqual([
      { exchange: 'NFO', token: '35001', symbol: '35001' },
    ]);
  });

  it('is capped (bounded per socket)', () => {
    const many = Array.from({ length: MAX_BROWSER_REFS_PER_SOCKET + 20 }, (_, i) => ({ token: String(i + 1), exchange: 'NSE' }));
    expect(parseFeedRefs({ refs: many }).refs).toHaveLength(MAX_BROWSER_REFS_PER_SOCKET);
    expect(parseFeedRefs({ refs: many }, 3).refs).toHaveLength(3);
  });
});

describe('browserPriority / browserOwner', () => {
  it('maps purposes to the spec priorities and anything else to a viewed chart (4), never 0 or 1', () => {
    expect(browserPriority('context')).toBe(2);
    expect(browserPriority('watchlist')).toBe(3);
    expect(browserPriority('chart')).toBe(4);
    expect(browserPriority(undefined)).toBe(4);
    expect(browserPriority('positions')).toBe(4);
    expect(browserPriority('__proto__')).toBe(4);
    expect(browserPriority(0)).toBe(4);
  });

  it('names one owner per socket', () => {
    expect(browserOwner('abc')).toBe('browser:abc');
  });
});

describe('priceToBrowserTick', () => {
  it('is a Quote-compatible TickData: exchange, change vs the previous close, depth, receipt time', () => {
    const t = priceToBrowserTick(OPT);
    expect(t).toMatchObject({
      token: '35001',
      symbol: 'NIFTY26OCT25000CE',
      exchange: 'NFO',
      ltp: 121,
      open: 100,
      high: 125,
      low: 95,
      close: 110,
      volume: 9000,
      oi: 120_000,
      change: 11,
      at: AT,
      source: 'ws',
      depth: OPT.depth,
    });
    expect(t.changePercent).toBeCloseTo(10, 6);
    expect(t.timestamp).toEqual(new Date(AT));
  });

  it('carries no change when the broker reported no day bar (never a -100 % day)', () => {
    const bare: Price = { ...OPT, day: undefined, depth: undefined };
    const t = priceToBrowserTick(bare);
    expect(t).not.toHaveProperty('change');
    expect(t).not.toHaveProperty('changePercent');
    expect(t).not.toHaveProperty('depth');
    expect(t.close).toBe(0);
  });
});

describe('priceToQuote / priceToDepth', () => {
  it('builds the /quote Quote, preferring the caller’s symbol, with the price’s own timestamp', () => {
    const q = priceToQuote(OPT, 'NIFTY 25000 CE');
    expect(q).toMatchObject({ token: '35001', symbol: 'NIFTY 25000 CE', exchange: 'NFO', ltp: 121, close: 110, change: 11, oi: 120_000 });
    expect(q.timestamp).toEqual(new Date(AT));
    expect(priceToQuote(OPT).symbol).toBe('NIFTY26OCT25000CE');
  });

  it('a quote without a day bar has change 0, not a -100 % day', () => {
    const bare: Price = { ...OPT, day: undefined };
    expect(priceToQuote(bare)).toMatchObject({ close: 0, change: 0, changePercent: 0 });
  });

  it('builds the MarketDepth the depth card reads, and null without a book', () => {
    expect(priceToDepth(OPT)).toEqual({
      token: '35001',
      exchange: 'NFO',
      bids: [{ price: 120.95, qty: 75, orders: 3 }],
      asks: [{ price: 121.05, qty: 150, orders: 4 }],
      totalBidQty: 75,
      totalAskQty: 150,
      ts: AT,
    });
    const bare: Price = { ...OPT, depth: undefined };
    expect(priceToDepth(bare)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @td/api test -- browser-feed.spec`
Expected: FAIL with `Cannot find module './browser-feed'`.

- [ ] **Step 3: Implement**

Create `apps/api/src/modules/market-hub/browser-feed.ts`:

```typescript
import type { MarketDepth } from '@td/shared/types';
import type { TickData } from '../../common/interfaces/broker-adapter.interface';
import { tickToQuote, type QuoteResponse } from '../market-data/utils/tick-to-quote';
import { isHubExchange, type InstrumentRef, type Price, type Priority } from './hub.types';

/**
 * SP1 M4: what the owner's browser sees of the hub. Pure (no Nest, no I/O), so
 * the market-data gateway and controller can import it without a module cycle.
 */

/** Spec §3.1: screen watches expire unless renewed (2 min). */
export const BROWSER_WATCH_TTL_MS = 120_000;
/** A socket renews its watches at half the TTL. */
export const BROWSER_RENEW_MS = 60_000;
/** Spec §5.3: standard maxAge for screens. */
export const SCREEN_MAX_AGE_MS = 15_000;
/** Bounded memory and slot pressure per browser socket. */
export const MAX_BROWSER_REFS_PER_SOCKET = 100;

/** Why the browser wants an instrument; decides its hub priority (spec §5.1). */
export type FeedPurpose = 'chart' | 'watchlist' | 'context';

const PURPOSE_PRIORITY: Readonly<Record<FeedPurpose, Priority>> = { context: 2, watchlist: 3, chart: 4 };

/** context 2 · watchlist 3 · chart (and anything unknown) 4. A browser can never claim 0 or 1. */
export function browserPriority(purpose: unknown): Priority {
  return typeof purpose === 'string' && Object.prototype.hasOwnProperty.call(PURPOSE_PRIORITY, purpose)
    ? PURPOSE_PRIORITY[purpose as FeedPurpose]
    : 4;
}

/** One watch owner per socket, so one tab's release never drops another tab's watch. */
export function browserOwner(socketId: string): string {
  return `browser:${socketId}`;
}

/** The `/ws` subscribe / unsubscribe body. `refs` (M4 client) win over `tokens` (old client). */
export interface SubscribeBody {
  tokens?: unknown;
  refs?: unknown;
  purpose?: unknown;
}

export interface ParsedRefs {
  refs: InstrumentRef[];
  /** Tokens that came without an exchange (an old client bundle) and were taken as NSE. */
  bareTokens: number;
}

/**
 * The gateway's exchange fix (spec §1.7): every ref carries the exchange the
 * client sent. Accepted: `refs: [{ token, exchange, symbol? }]`, or `tokens`
 * as `EXCHANGE:token` strings; a bare token still means NSE so a stale tab keeps
 * working, and is counted. Unknown exchanges, non-numeric and zero tokens are
 * dropped. De-duplicated by EXCHANGE:token (never the token alone), capped.
 */
export function parseFeedRefs(body: SubscribeBody | null | undefined, cap = MAX_BROWSER_REFS_PER_SOCKET): ParsedRefs {
  const out = new Map<string, InstrumentRef>();
  let bareTokens = 0;
  const add = (exchange: string, token: string, symbol?: string): void => {
    const ex = exchange.trim().toUpperCase();
    const tk = token.trim();
    if (!isHubExchange(ex) || !/^\d+$/.test(tk) || /^0+$/.test(tk)) return;
    const key = `${ex}:${tk}`;
    if (out.has(key) || out.size >= cap) return;
    out.set(key, { exchange: ex, token: tk, symbol: symbol?.trim() || tk });
  };
  if (Array.isArray(body?.refs)) {
    for (const r of body.refs as unknown[]) {
      const ref = r as { token?: unknown; exchange?: unknown; symbol?: unknown } | null;
      if (!ref || typeof ref.token !== 'string' || typeof ref.exchange !== 'string') continue;
      add(ref.exchange, ref.token, typeof ref.symbol === 'string' ? ref.symbol : undefined);
    }
  } else if (Array.isArray(body?.tokens)) {
    for (const t of body.tokens as unknown[]) {
      if (typeof t !== 'string') continue;
      const i = t.indexOf(':');
      if (i > 0) {
        add(t.slice(0, i), t.slice(i + 1));
      } else {
        bareTokens++;
        add('NSE', t);
      }
    }
  }
  return { refs: [...out.values()], bareTokens };
}

/**
 * The `/ws` `tick` payload for a hub price: the legacy `TickData` fields (so
 * every existing consumer keeps working) plus `exchange`, `at`, `source`, and
 * `change` / `changePercent` when the broker reported the previous close. With
 * those, a tick is also a `Quote`, which the market store accepts as-is.
 */
export interface BrowserTick extends TickData {
  exchange: string;
  /** Receipt time (ms epoch); `timestamp` is the same instant. */
  at: number;
  source: Price['source'];
  change?: number;
  changePercent?: number;
}

/** A hub price as the legacy TickData shape (zeros where the broker reported no day bar). */
export function priceToTickData(p: Price, symbol?: string): TickData {
  return {
    token: p.ref.token,
    symbol: symbol || p.ref.symbol,
    exchange: p.ref.exchange,
    ltp: p.ltp,
    open: p.day?.open ?? 0,
    high: p.day?.high ?? 0,
    low: p.day?.low ?? 0,
    close: p.day?.close ?? 0,
    volume: p.volume ?? 0,
    oi: p.oi,
    timestamp: new Date(p.at),
    ...(p.depth ? { depth: p.depth } : {}),
  };
}

export function priceToBrowserTick(p: Price): BrowserTick {
  const t = priceToTickData(p);
  const out: BrowserTick = { ...t, exchange: p.ref.exchange, at: p.at, source: p.source };
  if (p.day && p.day.close > 0) {
    const q = tickToQuote(t, { exchange: p.ref.exchange });
    out.change = q.change;
    out.changePercent = q.changePercent;
  }
  return out;
}

/** The `/quote` Quote for a hub price; its `timestamp` is the price's own receipt time (the age label). */
export function priceToQuote(p: Price, symbol?: string): QuoteResponse {
  return tickToQuote(priceToTickData(p, symbol), { exchange: p.ref.exchange, symbol });
}

/** The `/depth` MarketDepth for a hub price; null when the price carries no book. */
export function priceToDepth(p: Price): MarketDepth | null {
  if (!p.depth) return null;
  const sum = (levels: { qty: number }[]) => levels.reduce((s, l) => s + l.qty, 0);
  return {
    token: p.ref.token,
    exchange: p.ref.exchange,
    bids: p.depth.bids.map((l) => ({ ...l })),
    asks: p.depth.asks.map((l) => ({ ...l })),
    totalBidQty: sum(p.depth.bids),
    totalAskQty: sum(p.depth.asks),
    ts: p.at,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @td/api test -- browser-feed.spec tick-to-quote.spec only-door.spec`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/market-hub/browser-feed.ts apps/api/src/modules/market-hub/browser-feed.spec.ts
git commit -m "feat(market-hub): browser wire format and exchange-aware feed refs" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/market-hub/browser-feed.ts apps/api/src/modules/market-hub/browser-feed.spec.ts
```

---

### Task 4: Gateway exchange fix and `EXCHANGE:token` coalescing (every user, not behind the switch)

**Files:**
- Modify: `apps/api/src/modules/market-data/gateways/market-data.gateway.ts`
- Modify: `apps/api/src/modules/market-data/gateways/market-data.gateway.spec.ts`

**Interfaces:**
- Consumes: `parseFeedRefs`, `SubscribeBody` (Task 3); `UserFeedManager.subscribe/unsubscribe` (unchanged).
- Produces:

```typescript
// market-data.gateway.ts (module-private)
function toTokenRef(ref: InstrumentRef): TokenRef      // the client's exchange; the NSE hard-code is gone
function tickKey(tick: TickData): string                // `${tick.exchange ?? ''}:${tick.token}`
MarketDataGateway.handleSubscribe(client, data: SubscribeBody)   // ack { subscribed: refs.map(r => r.token) }
MarketDataGateway.handleUnsubscribe(client, data: SubscribeBody)
```

- [ ] **Step 1: Write the failing tests**

Append inside `describe('MarketDataGateway', …)` in `market-data.gateway.spec.ts`:

```typescript
  it('subscribe uses the exchange the client sends, so an NFO option is not subscribed as NSE', () => {
    const { gw, manager } = makeGateway();
    const sock = fakeSocket(signToken('u1'));
    gw.handleConnection(sock as any);
    const ack = gw.handleSubscribe(sock as any, {
      refs: [
        { token: '35001', exchange: 'NFO', symbol: 'NIFTY26OCT25000CE' },
        { token: '2885', exchange: 'nse' },
      ],
    });
    expect(manager.subscribe).toHaveBeenCalledWith('u1', [
      { token: '35001', exchange: 'NFO' },
      { token: '2885', exchange: 'NSE' },
    ]);
    expect(ack).toEqual({ event: 'subscribed', data: { subscribed: ['35001', '2885'] } });
  });

  it('accepts EXCHANGE:token strings and drops unknown exchanges and junk tokens', () => {
    const { gw, manager } = makeGateway();
    const sock = fakeSocket(signToken('u1'));
    gw.handleConnection(sock as any);
    gw.handleSubscribe(sock as any, { tokens: ['MCX:4321', 'CDS:1', 'abc', '0'] });
    expect(manager.subscribe).toHaveBeenCalledWith('u1', [{ token: '4321', exchange: 'MCX' }]);
  });

  it('does not call the manager when nothing valid was sent', () => {
    const { gw, manager } = makeGateway();
    const sock = fakeSocket(signToken('u1'));
    gw.handleConnection(sock as any);
    gw.handleSubscribe(sock as any, { refs: [{ token: '1', exchange: 'XYZ' }] });
    expect(manager.subscribe).not.toHaveBeenCalled();
  });

  it('unsubscribe uses the same exchange-aware refs', () => {
    const { gw, manager } = makeGateway();
    const sock = fakeSocket(signToken('u1'));
    gw.handleConnection(sock as any);
    gw.handleUnsubscribe(sock as any, { refs: [{ token: '35001', exchange: 'NFO' }] });
    expect(manager.unsubscribe).toHaveBeenCalledWith('u1', [{ token: '35001', exchange: 'NFO' }]);
  });

  it('coalesces per EXCHANGE:token: the same token on two exchanges is two ticks', () => {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    const { gw } = makeGateway();
    (gw as any).server = { to };
    gw.emitTickToUser('u1', { token: '1594', exchange: 'NSE', ltp: 1 } as any);
    gw.emitTickToUser('u1', { token: '1594', exchange: 'MCX', ltp: 2 } as any);
    gw.emitTickToUser('u1', { token: '1594', exchange: 'NSE', ltp: 3 } as any); // newest NSE wins
    gw.flushForTest();
    expect(emit.mock.calls).toEqual([
      ['tick', { token: '1594', exchange: 'NSE', ltp: 3 }],
      ['tick', { token: '1594', exchange: 'MCX', ltp: 2 }],
    ]);
  });
```

The existing tests `handleSubscribe routes tokens to the manager for the socket user` and `handleUnsubscribe routes tokens to the manager` stay as they are: bare tokens from an old bundle are still NSE.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @td/api test -- market-data.gateway.spec`
Expected: FAIL. The NFO ref is subscribed as `{ token: undefined, exchange: 'NSE' }` (there is no `refs` handling), `'MCX:4321'` is sent as an NSE token, and the two `1594` ticks collapse into one.

- [ ] **Step 3: Implement**

In `market-data.gateway.ts`:
- add these imports after the `user-feed.types` import:

```typescript
import { parseFeedRefs, type SubscribeBody } from '../../market-hub/browser-feed';
import type { InstrumentRef } from '../../market-hub/hub.types';
```

- replace the `DEFAULT_EXCHANGE` constant, its comment, and `toTokenRef` with:

```typescript
/** The manager's TokenRef for a parsed browser ref: the client's own exchange, never a hard-coded NSE. */
function toTokenRef(ref: InstrumentRef): TokenRef {
  return { token: ref.token, exchange: ref.exchange };
}

/** Coalescing key: EXCHANGE:token. Tokens collide across exchanges (NSE cash vs NFO vs MCX). */
function tickKey(tick: TickData): string {
  return `${tick.exchange ?? ''}:${tick.token}`;
}
```

- replace `handleSubscribe` and `handleUnsubscribe` with:

```typescript
  /**
   * Client subscribes to instruments for live updates. Each ref carries its
   * exchange (parseFeedRefs); interest is tracked per user by the
   * UserFeedManager, which owns the broker feed session.
   */
  @SubscribeMessage('subscribe')
  handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: SubscribeBody,
  ): { event: string; data: { subscribed: string[] } } {
    const { refs, bareTokens } = parseFeedRefs(data);
    const userId = client.data?.userId as string | undefined;

    if (userId && refs.length > 0) {
      // Floated: the ack returns immediately. subscribe() can reject (e.g. the
      // per-user feed flag is disabled → factory throws) — swallow it here so a
      // rejected promise never becomes an unhandledRejection / process crash.
      // No secrets in the message.
      this.userFeedManager.subscribe(userId, refs.map(toTokenRef)).catch((err) => {
        this.logger.debug(
          `subscribe failed for user ${userId}: ${err instanceof Error ? err.message : err}`,
        );
      });
    }
    if (bareTokens > 0) {
      this.logger.debug(`Client ${client.id} sent ${bareTokens} token(s) without an exchange; taken as NSE (old client)`);
    }

    this.logger.debug(
      `Client ${client.id} (user ${userId ?? '?'}) subscribed to ${refs.length} instrument(s)`,
    );

    return {
      event: 'subscribed',
      data: { subscribed: refs.map((r) => r.token) },
    };
  }

  /**
   * Client unsubscribes from instruments (same exchange-aware refs).
   */
  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: SubscribeBody,
  ): { event: string; data: { unsubscribed: string[] } } {
    const { refs } = parseFeedRefs(data);
    const userId = client.data?.userId as string | undefined;

    if (userId && refs.length > 0) {
      // Floated + guarded like handleSubscribe: a rejection must not surface as
      // an unhandledRejection.
      this.userFeedManager.unsubscribe(userId, refs.map(toTokenRef)).catch((err) => {
        this.logger.debug(
          `unsubscribe failed for user ${userId}: ${err instanceof Error ? err.message : err}`,
        );
      });
    }

    this.logger.debug(
      `Client ${client.id} (user ${userId ?? '?'}) unsubscribed from ${refs.length} instrument(s)`,
    );

    return {
      event: 'unsubscribed',
      data: { unsubscribed: refs.map((r) => r.token) },
    };
  }
```

- in `emitTickToUser`, change `userPending.set(tick.token, tick);` to `userPending.set(tickKey(tick), tick);`, and in the `pendingTicks` field comment change `inner key: token` to `inner key: EXCHANGE:token`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @td/api test -- market-data.gateway.spec`
Expected: PASS (the existing 10 tests and the 5 new ones).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/market-data/gateways/market-data.gateway.ts apps/api/src/modules/market-data/gateways/market-data.gateway.spec.ts
git commit -m "fix(market-data): gateway subscribes on the client's exchange and coalesces ticks by exchange + token" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/market-data/gateways/market-data.gateway.ts apps/api/src/modules/market-data/gateways/market-data.gateway.spec.ts
```

---

### Task 5: Gateway hub path: `ticks$` to the owner's room, hub watches per socket (HUB_SERVES_BROWSER)

**Files:**
- Modify: `apps/api/src/modules/market-data/gateways/market-data.gateway.ts` (full file below)
- Modify: `apps/api/src/modules/market-data/gateways/market-data.gateway.spec.ts`

**Interfaces:**
- Consumes: `lookupHubPrices`, `HubPriceSource.hubFor(userId, 'browser')`, `HubPrices.watch/unwatch/onPrice` (Task 1); `parseFeedRefs`, `browserPriority`, `browserOwner`, `priceToBrowserTick`, `BROWSER_WATCH_TTL_MS`, `BROWSER_RENEW_MS`, `MAX_BROWSER_REFS_PER_SOCKET` (Task 3).
- Produces:

```typescript
constructor(userFeedManager: UserFeedManager, @Optional() moduleRef?: ModuleRef)
// emitted to each authenticated socket on connect:
'feed-source' → { source: 'hub' | 'legacy' }
// emitted to the hub-served user's room for every hub price (coalesced per EXCHANGE:token, 100 ms):
'tick' → BrowserTick
MarketDataGateway.emitTickToUser(userId, tick)   // dropped for a hub-served user (duplicate of the hub's price)
```

- [ ] **Step 1: Write the failing tests**

In `market-data.gateway.spec.ts`:
- add `import type { Price } from '../../market-hub/hub.types';` below the existing imports;
- change `function fakeSocket(token?: string) {` to `function fakeSocket(token?: string, id = 's1') {` and its `id: 's1',` to `id,`;
- append after `makeGateway`:

```typescript
/** A hub that hands its price listener back to the test. */
function fakeHub() {
  const listeners = new Set<(p: Price) => void>();
  const hub = {
    price: jest.fn(),
    prices: jest.fn(),
    watch: jest.fn().mockResolvedValue(undefined),
    unwatch: jest.fn().mockResolvedValue(undefined),
    onPrice: jest.fn((fn: (p: Price) => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    }),
  };
  return { hub, listeners, push: (p: Price) => listeners.forEach((fn) => fn(p)) };
}

/** A gateway whose ModuleRef resolves a HubPriceSource serving `serves` (the owner) for 'browser' only. */
function hubGateway(serves: string[] = ['owner']) {
  const { hub, listeners, push } = fakeHub();
  const source = {
    hubFor: jest.fn((userId: string | null, consumer: string) =>
      consumer === 'browser' && userId !== null && serves.includes(userId) ? hub : null,
    ),
    record: jest.fn(),
  };
  const moduleRef = { get: jest.fn(() => source) };
  const manager = fakeManager();
  const gw = new MarketDataGateway(manager, moduleRef as any);
  const emitsByRoom: Record<string, Array<{ event: string; payload: any }>> = {};
  (gw as any).server = {
    to: jest.fn((room: string) => ({
      emit: (event: string, payload: unknown) => {
        (emitsByRoom[room] ??= []).push({ event, payload });
      },
    })),
  };
  return { gw, manager, hub, listeners, push, source, emitsByRoom };
}

const OPT = (ltp: number, exchange: Price['ref']['exchange'] = 'NFO'): Price => ({
  ref: { exchange, token: '35001', symbol: 'NIFTY26OCT25000CE' },
  ltp,
  at: 1_760_000_000_000,
  source: 'ws',
  day: { open: 100, high: 125, low: 95, close: 110 },
});
```

- append inside `describe('MarketDataGateway', …)`:

```typescript
  describe('hub path (HUB_SERVES_BROWSER)', () => {
    it('tells each browser which path serves it: hub for the owner, legacy for everyone else', () => {
      const { gw } = hubGateway();
      const owner = fakeSocket(signToken('owner'), 's-owner');
      const other = fakeSocket(signToken('u2'), 's-other');
      gw.handleConnection(owner as any);
      gw.handleConnection(other as any);
      expect(owner.emit).toHaveBeenCalledWith('feed-source', { source: 'hub' });
      expect(other.emit).toHaveBeenCalledWith('feed-source', { source: 'legacy' });
    });

    it('owner: subscribe watches on the hub at the purpose priority, per socket, with the screen TTL — never the manager', () => {
      const { gw, hub, manager } = hubGateway();
      const sock = fakeSocket(signToken('owner'));
      gw.handleConnection(sock as any);
      gw.handleSubscribe(sock as any, { refs: [{ token: '35001', exchange: 'NFO', symbol: 'NIFTY26OCT25000CE' }], purpose: 'chart' });
      gw.handleSubscribe(sock as any, { refs: [{ token: '2885', exchange: 'NSE', symbol: 'RELIANCE' }], purpose: 'watchlist' });
      gw.handleSubscribe(sock as any, { refs: [{ token: '99926000', exchange: 'NSE', symbol: 'NIFTY' }], purpose: 'context' });
      expect(hub.watch.mock.calls).toEqual([
        [[{ exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' }], 4, 'browser:s1', 120_000],
        [[{ exchange: 'NSE', token: '2885', symbol: 'RELIANCE' }], 3, 'browser:s1', 120_000],
        [[{ exchange: 'NSE', token: '99926000', symbol: 'NIFTY' }], 2, 'browser:s1', 120_000],
      ]);
      expect(manager.subscribe).not.toHaveBeenCalled();
    });

    it('owner: a repeat subscribe is a no-op unless it raises the priority', () => {
      const { gw, hub } = hubGateway();
      const sock = fakeSocket(signToken('owner'));
      gw.handleConnection(sock as any);
      const ref = { token: '2885', exchange: 'NSE', symbol: 'RELIANCE' };
      gw.handleSubscribe(sock as any, { refs: [ref], purpose: 'chart' });
      gw.handleSubscribe(sock as any, { refs: [ref], purpose: 'chart' });
      gw.handleSubscribe(sock as any, { refs: [ref], purpose: 'watchlist' });
      expect(hub.watch.mock.calls.map((c) => c[1])).toEqual([4, 3]);
    });

    it('pushes every hub price to the owner room only, coalesced per EXCHANGE:token, as a Quote-compatible tick', () => {
      const { gw, push, emitsByRoom } = hubGateway();
      gw.handleConnection(fakeSocket(signToken('owner'), 's-owner') as any);
      gw.handleConnection(fakeSocket(signToken('u2'), 's-other') as any);
      push(OPT(120));
      push(OPT(121)); // newest wins within the 100 ms window
      push({ ...OPT(5, 'MCX'), ref: { exchange: 'MCX', token: '35001', symbol: 'CRUDEOIL' } }); // same token, other exchange
      gw.flushForTest();
      const ticks = emitsByRoom['user:owner'].filter((e) => e.event === 'tick').map((e) => e.payload);
      expect(ticks).toHaveLength(2);
      expect(ticks[0]).toMatchObject({ token: '35001', exchange: 'NFO', symbol: 'NIFTY26OCT25000CE', ltp: 121, close: 110, change: 11, source: 'ws' });
      expect(ticks[1]).toMatchObject({ token: '35001', exchange: 'MCX', ltp: 5 });
      expect(emitsByRoom['user:u2']).toBeUndefined();
    });

    it('drops the legacy manager tick for a hub-served user (same session: it would be a duplicate)', () => {
      const { gw, emitsByRoom } = hubGateway();
      gw.handleConnection(fakeSocket(signToken('owner'), 's-owner') as any);
      gw.emitTickToUser('owner', { token: '35001', exchange: 'NFO', ltp: 1 } as any);
      gw.emitTickToUser('u2', { token: '2885', exchange: 'NSE', ltp: 2 } as any);
      gw.flushForTest();
      expect(emitsByRoom['user:owner']).toBeUndefined();
      expect(emitsByRoom['user:u2']).toEqual([{ event: 'tick', payload: { token: '2885', exchange: 'NSE', ltp: 2 } }]);
    });

    it('a non-owner never reads the owner hub: legacy feed-source, manager subscribe with the right exchange, legacy ticks', () => {
      const { gw, hub, manager, listeners, source } = hubGateway();
      const sock = fakeSocket(signToken('u2'));
      gw.handleConnection(sock as any);
      gw.handleSubscribe(sock as any, { refs: [{ token: '35001', exchange: 'NFO' }], purpose: 'chart' });
      expect(source.hubFor).toHaveBeenCalledWith('u2', 'browser');
      expect(hub.watch).not.toHaveBeenCalled();
      expect(listeners.size).toBe(0);
      expect(manager.subscribe).toHaveBeenCalledWith('u2', [{ token: '35001', exchange: 'NFO' }]);
    });

    it('unsubscribe and disconnect unwatch that socket’s refs; the listener goes with the user’s last socket', () => {
      const { gw, hub, listeners, manager } = hubGateway();
      const a = fakeSocket(signToken('owner'), 'a');
      const b = fakeSocket(signToken('owner'), 'b');
      gw.handleConnection(a as any);
      gw.handleConnection(b as any);
      expect(hub.onPrice).toHaveBeenCalledTimes(1); // one listener per user, not per tab
      gw.handleSubscribe(a as any, { refs: [{ token: '35001', exchange: 'NFO' }, { token: '2885', exchange: 'NSE' }] });
      gw.handleUnsubscribe(a as any, { refs: [{ token: '35001', exchange: 'NFO' }] });
      expect(hub.unwatch).toHaveBeenLastCalledWith([{ exchange: 'NFO', token: '35001', symbol: '35001' }], 'browser:a');
      gw.handleDisconnect(a as any);
      expect(hub.unwatch).toHaveBeenLastCalledWith([{ exchange: 'NSE', token: '2885', symbol: '2885' }], 'browser:a');
      expect(listeners.size).toBe(1);
      gw.handleDisconnect(b as any);
      expect(listeners.size).toBe(0);
      expect(manager.unsubscribe).not.toHaveBeenCalled();
    });

    it('a socket holds at most 100 hub watches', () => {
      const { gw, hub } = hubGateway();
      const sock = fakeSocket(signToken('owner'));
      gw.handleConnection(sock as any);
      const refs = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ token: String(from + i), exchange: 'NSE' }));
      gw.handleSubscribe(sock as any, { refs: refs(1, 90) });
      gw.handleSubscribe(sock as any, { refs: refs(1001, 30) });
      const watched = hub.watch.mock.calls.reduce((n, c) => n + (c[0] as unknown[]).length, 0);
      expect(watched).toBe(100);
    });

    it('renews every hub watch on the renew timer, grouped by priority', () => {
      jest.useFakeTimers();
      try {
        const { gw, hub } = hubGateway();
        gw.afterInit();
        const sock = fakeSocket(signToken('owner'));
        gw.handleConnection(sock as any);
        gw.handleSubscribe(sock as any, { refs: [{ token: '2885', exchange: 'NSE' }], purpose: 'watchlist' });
        gw.handleSubscribe(sock as any, { refs: [{ token: '35001', exchange: 'NFO' }], purpose: 'chart' });
        hub.watch.mockClear();
        jest.advanceTimersByTime(60_000);
        expect(hub.watch.mock.calls).toEqual(
          expect.arrayContaining([
            [[{ exchange: 'NSE', token: '2885', symbol: '2885' }], 3, 'browser:s1', 120_000],
            [[{ exchange: 'NFO', token: '35001', symbol: '35001' }], 4, 'browser:s1', 120_000],
          ]),
        );
        gw.onModuleDestroy();
      } finally {
        jest.useRealTimers();
      }
    });

    it('no hub in this container (lookup throws or no ModuleRef) is the legacy path', () => {
      const throwing = new MarketDataGateway(fakeManager(), { get: jest.fn(() => { throw new Error('no provider'); }) } as any);
      const s1 = fakeSocket(signToken('owner'));
      throwing.handleConnection(s1 as any);
      expect(s1.emit).toHaveBeenCalledWith('feed-source', { source: 'legacy' });

      const { gw: plain, manager } = makeGateway();
      const s2 = fakeSocket(signToken('owner'));
      plain.handleConnection(s2 as any);
      expect(s2.emit).toHaveBeenCalledWith('feed-source', { source: 'legacy' });
      plain.handleSubscribe(s2 as any, { refs: [{ token: '2885', exchange: 'NSE' }] });
      expect(manager.subscribe).toHaveBeenCalledWith('owner', [{ token: '2885', exchange: 'NSE' }]);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @td/api test -- market-data.gateway.spec`
Expected: FAIL. No `feed-source` emit; `hub.watch` is never called (the owner's subscribe still goes to the manager); no `tick` reaches `user:owner` from a hub price; the owner's legacy tick is still emitted.

- [ ] **Step 3: Implement**

Replace `apps/api/src/modules/market-data/gateways/market-data.gateway.ts` with:

```typescript
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Server, Socket } from 'socket.io';
import { WS_NAMESPACE } from '@td/shared/constants';
import { OIData } from '@td/shared/types';
import type { TickData } from '../../../common/interfaces/broker-adapter.interface';
import { getUserIdFromSocket } from '../../../common/ws/authenticate-user-socket';
import { UserFeedManager } from '../services/user-feed-manager.service';
import type { FeedState, TokenRef } from '../services/user-feed.types';
import {
  BROWSER_RENEW_MS,
  BROWSER_WATCH_TTL_MS,
  MAX_BROWSER_REFS_PER_SOCKET,
  browserOwner,
  browserPriority,
  parseFeedRefs,
  priceToBrowserTick,
  type SubscribeBody,
} from '../../market-hub/browser-feed';
import { lookupHubPrices, type HubPriceSource, type HubPrices } from '../../market-hub/hub-prices';
import { refKey, type InstrumentRef, type Priority } from '../../market-hub/hub.types';

export interface CandlePayload {
  token: string;
  timeframe: string;
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ConnectionStatusPayload {
  connected: boolean;
  activeSubscriptions: number;
  timestamp: Date;
}

/**
 * Max flush rate for coalesced tick broadcasts. Angel One can emit hundreds
 * of ticks per second; the UI only needs a few updates per second per symbol.
 * 100ms → max 10 updates/sec per instrument regardless of upstream tick rate.
 */
const TICK_FLUSH_INTERVAL_MS = 100;

const CORS_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:4000';

/** The manager's TokenRef for a parsed browser ref: the client's own exchange, never a hard-coded NSE. */
function toTokenRef(ref: InstrumentRef): TokenRef {
  return { token: ref.token, exchange: ref.exchange };
}

/** Coalescing key: EXCHANGE:token. Tokens collide across exchanges (NSE cash vs NFO vs MCX). */
function tickKey(tick: TickData): string {
  return `${tick.exchange ?? ''}:${tick.token}`;
}

/** hub.watch / hub.unwatch never reject by contract; this keeps a broken hub from ever surfacing. */
function quietly(p: Promise<unknown>): void {
  void Promise.resolve(p).catch(() => undefined);
}

/** One hub-served socket: its user, that user's hub, and what it watches (≤ MAX_BROWSER_REFS_PER_SOCKET). */
interface HubSocket {
  userId: string;
  hub: HubPrices;
  watches: Map<string, { ref: InstrumentRef; priority: Priority }>;
}

@WebSocketGateway({
  namespace: WS_NAMESPACE,
  cors: {
    origin: CORS_ORIGIN,
    credentials: true,
  },
  transports: ['polling', 'websocket'],
})
export class MarketDataGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(MarketDataGateway.name);

  @WebSocketServer()
  server: Server;

  /** Ids of currently connected (authenticated) sockets — for status reporting. */
  private readonly connectedClients = new Set<string>();

  /**
   * Latest pending tick per instrument, per user, awaiting the next flush.
   * Outer key: userId; inner key: EXCHANGE:token. Writes overwrite — stale
   * prices are discarded in favor of the newest before the next flush.
   */
  private readonly pendingTicks = new Map<string, Map<string, TickData>>();
  private flushInterval: NodeJS.Timeout | null = null;

  /**
   * SP1 M4 (HUB_SERVES_BROWSER). A socket whose user `hubFor(userId, 'browser')`
   * serves is fed by that user's hub: its subscriptions are hub watches (priority
   * from the purpose, TTL renewed), and every hub price reaches the user's room.
   * Everyone else keeps the UserFeedManager path below.
   */
  private hubSourceRef: HubPriceSource | null = null;
  private readonly hubSockets = new Map<string, HubSocket>();
  /** One hub price listener per hub-served user, alive while that user has a hub-served socket. */
  private readonly hubListeners = new Map<string, { off: () => void; sockets: number }>();
  private renewTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly userFeedManager: UserFeedManager,
    // Resolves HUB_PRICE_SOURCE lazily: MarketHubModule imports MarketDataModule, so injecting it would cycle.
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  afterInit(): void {
    this.logger.log('Market Data WebSocket Gateway initialized');

    // Route the manager's userId-tagged tick/state events to the right room.
    this.userFeedManager.setHandlers(
      (userId, tick) => this.emitTickToUser(userId, tick),
      (userId, state) => this.emitFeedStateToUser(userId, state),
    );

    this.flushInterval = setInterval(
      () => this.flushPendingTicks(),
      TICK_FLUSH_INTERVAL_MS,
    );
    this.renewTimer = setInterval(() => this.renewHubWatches(), BROWSER_RENEW_MS);
    this.renewTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
    for (const l of this.hubListeners.values()) l.off();
    this.hubListeners.clear();
    this.hubSockets.clear();
    this.flushPendingTicks();
  }

  handleConnection(client: Socket): void {
    const userId = getUserIdFromSocket(client);
    if (!userId) {
      this.logger.warn(`Rejected unauthenticated socket: ${client.id}`);
      client.disconnect();
      return;
    }
    client.data.userId = userId;
    client.join(`user:${userId}`);
    this.connectedClients.add(client.id);
    const hub = this.hubFor(userId);
    if (hub) this.attachHub(client.id, userId, hub);
    // Tells the browser whether its quote/depth/indices/watchlist/live-edge polls may stop while Live.
    client.emit('feed-source', { source: hub ? 'hub' : 'legacy' });
    this.logger.log(`Client connected: ${client.id} (user ${userId}, ${hub ? 'hub' : 'legacy'} feed)`);
  }

  handleDisconnect(client: Socket): void {
    this.connectedClients.delete(client.id);
    this.detachHub(client.id);
    const userId = client.data?.userId as string | undefined;
    this.logger.log(`Client disconnected: ${client.id} (user ${userId ?? '?'})`);
    if (userId) {
      this.userFeedManager.releaseUser(userId);
    }
  }

  /**
   * Client subscribes to instruments for live updates. Each ref carries its
   * exchange (parseFeedRefs). A hub-served socket watches on its user's hub at
   * the purpose's priority; any other socket goes to the UserFeedManager,
   * which owns that user's broker feed session.
   */
  @SubscribeMessage('subscribe')
  handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: SubscribeBody,
  ): { event: string; data: { subscribed: string[] } } {
    const { refs, bareTokens } = parseFeedRefs(data);
    const userId = client.data?.userId as string | undefined;

    if (userId && refs.length > 0) {
      const hubSocket = this.hubSockets.get(client.id);
      if (hubSocket) {
        this.watchOnHub(client.id, hubSocket, refs, browserPriority(data?.purpose));
      } else {
        // Floated: the ack returns immediately. subscribe() can reject (e.g. the
        // per-user feed flag is disabled → factory throws) — swallow it here so a
        // rejected promise never becomes an unhandledRejection / process crash.
        // No secrets in the message.
        this.userFeedManager.subscribe(userId, refs.map(toTokenRef)).catch((err) => {
          this.logger.debug(
            `subscribe failed for user ${userId}: ${err instanceof Error ? err.message : err}`,
          );
        });
      }
    }
    if (bareTokens > 0) {
      this.logger.debug(`Client ${client.id} sent ${bareTokens} token(s) without an exchange; taken as NSE (old client)`);
    }

    this.logger.debug(
      `Client ${client.id} (user ${userId ?? '?'}) subscribed to ${refs.length} instrument(s)`,
    );

    return {
      event: 'subscribed',
      data: { subscribed: refs.map((r) => r.token) },
    };
  }

  /**
   * Client unsubscribes from instruments (same exchange-aware refs).
   */
  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: SubscribeBody,
  ): { event: string; data: { unsubscribed: string[] } } {
    const { refs } = parseFeedRefs(data);
    const userId = client.data?.userId as string | undefined;

    if (userId && refs.length > 0) {
      const hubSocket = this.hubSockets.get(client.id);
      if (hubSocket) {
        const gone = refs.filter((r) => hubSocket.watches.delete(refKey(r)));
        if (gone.length > 0) quietly(hubSocket.hub.unwatch(gone, browserOwner(client.id)));
      } else {
        // Floated + guarded like handleSubscribe: a rejection must not surface as
        // an unhandledRejection.
        this.userFeedManager.unsubscribe(userId, refs.map(toTokenRef)).catch((err) => {
          this.logger.debug(
            `unsubscribe failed for user ${userId}: ${err instanceof Error ? err.message : err}`,
          );
        });
      }
    }

    this.logger.debug(
      `Client ${client.id} (user ${userId ?? '?'}) unsubscribed from ${refs.length} instrument(s)`,
    );

    return {
      event: 'unsubscribed',
      data: { unsubscribed: refs.map((r) => r.token) },
    };
  }

  // ------------------------------------------------------------------
  //  Per-user push methods
  // ------------------------------------------------------------------

  /**
   * Queue a UserFeedManager tick for the next flush, scoped to one user. The
   * emitted `'tick'` payload is the raw `TickData` shape (NOT a `Quote`).
   * Dropped for a hub-served user: the hub runs on that same session and
   * already pushes this instrument (exchange-exact, with polled quotes too).
   */
  emitTickToUser(userId: string, tick: TickData): void {
    if (this.hubListeners.has(userId)) return;
    this.queueTick(userId, tick);
  }

  private queueTick(userId: string, tick: TickData): void {
    let userPending = this.pendingTicks.get(userId);
    if (!userPending) {
      userPending = new Map<string, TickData>();
      this.pendingTicks.set(userId, userPending);
    }
    userPending.set(tickKey(tick), tick);
  }

  private flushPendingTicks(): void {
    if (this.pendingTicks.size === 0) return;
    for (const [userId, userPending] of this.pendingTicks) {
      for (const tick of userPending.values()) {
        this.server.to(`user:${userId}`).emit('tick', tick);
      }
    }
    this.pendingTicks.clear();
  }

  /** Test hook: run the coalesced flush synchronously. */
  flushForTest(): void {
    this.flushPendingTicks();
  }

  /**
   * Emit a closed candle to a single user's room. Candles are not coalesced —
   * each closed candle is a discrete event.
   */
  emitCandleToUser(userId: string, candle: CandlePayload): void {
    this.server.to(`user:${userId}`).emit('candle', candle);
  }

  /** Emit the broker feed lifecycle state to a single user's room. */
  emitFeedStateToUser(userId: string, state: FeedState): void {
    this.server.to(`user:${userId}`).emit('feed-state', state);
  }

  /**
   * Emit OI update to clients subscribed to that token's room.
   * NOTE: currently inert — there is NO frontend `'oi-update'` consumer, and
   * this still emits to the legacy `token:` room (no client joins it) rather
   * than the per-user room. Retained so `oi-tracker.processor` keeps compiling;
   * needs per-user OI routing (like emitTickToUser) when a consumer returns.
   */
  emitOIUpdate(data: OIData): void {
    this.server.to(`token:${data.token}`).emit('oi-update', data);
  }

  /**
   * Broadcast connection status to ALL connected clients.
   */
  emitConnectionStatus(status: ConnectionStatusPayload): void {
    // `@WebSocketServer()` is only populated when an HTTP server is attached.
    // A headless boot — `NestFactory.createApplicationContext`, used by workers
    // and one-shot scripts — has none, so this is null and the unguarded emit
    // took the whole process down from inside the feed's auto-start. Nobody is
    // listening in that mode, so dropping the broadcast is the correct no-op.
    this.server?.emit('connection-status', status);
  }

  /**
   * Get the count of currently connected (authenticated) clients.
   */
  getConnectedClientCount(): number {
    return this.connectedClients.size;
  }

  // ------------------------------------------------------------------
  //  SP1 M4 hub path
  // ------------------------------------------------------------------

  /** THE seam (hub-prices.ts): this user's hub for the browser, or null for the legacy path. */
  private hubFor(userId: string): HubPrices | null {
    try {
      if (!this.hubSourceRef) this.hubSourceRef = lookupHubPrices(this.moduleRef);
      return this.hubSourceRef?.hubFor(userId, 'browser') ?? null;
    } catch {
      return null;
    }
  }

  private attachHub(socketId: string, userId: string, hub: HubPrices): void {
    this.hubSockets.set(socketId, { userId, hub, watches: new Map() });
    const listener = this.hubListeners.get(userId);
    if (listener) {
      listener.sockets++;
      return;
    }
    const off = hub.onPrice((p) => this.queueTick(userId, priceToBrowserTick(p)));
    this.hubListeners.set(userId, { off, sockets: 1 });
  }

  private detachHub(socketId: string): void {
    const s = this.hubSockets.get(socketId);
    if (!s) return;
    this.hubSockets.delete(socketId);
    if (s.watches.size > 0) {
      quietly(s.hub.unwatch([...s.watches.values()].map((w) => w.ref), browserOwner(socketId)));
    }
    const listener = this.hubListeners.get(s.userId);
    if (listener && --listener.sockets <= 0) {
      listener.off();
      this.hubListeners.delete(s.userId);
    }
  }

  /** New refs, and refs whose priority this subscribe raises; bounded per socket. */
  private watchOnHub(socketId: string, s: HubSocket, refs: InstrumentRef[], priority: Priority): void {
    const fresh: InstrumentRef[] = [];
    for (const ref of refs) {
      const key = refKey(ref);
      const had = s.watches.get(key);
      if (had && had.priority <= priority) continue; // already watched at least this urgently
      if (!had && s.watches.size >= MAX_BROWSER_REFS_PER_SOCKET) continue;
      s.watches.set(key, { ref, priority });
      fresh.push(ref);
    }
    if (fresh.length > 0) quietly(s.hub.watch(fresh, priority, browserOwner(socketId), BROWSER_WATCH_TTL_MS));
  }

  /** Every BROWSER_RENEW_MS: renew each socket's watches before their TTL lapses. */
  private renewHubWatches(): void {
    for (const [socketId, s] of this.hubSockets) {
      const byPriority = new Map<Priority, InstrumentRef[]>();
      for (const w of s.watches.values()) {
        const list = byPriority.get(w.priority);
        if (list) list.push(w.ref);
        else byPriority.set(w.priority, [w.ref]);
      }
      for (const [priority, refs] of byPriority) {
        quietly(s.hub.watch(refs, priority, browserOwner(socketId), BROWSER_WATCH_TTL_MS));
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @td/api test -- market-data.gateway.spec market-feed.service.spec stock-monitor.service.spec only-door.spec`
Expected: PASS. `MarketFeedService`, `OiTrackerProcessor` and `StockMonitorService` inject the gateway and call only `emitConnectionStatus`, `emitOIUpdate` and `server`; none constructs it.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/market-data/gateways/market-data.gateway.ts apps/api/src/modules/market-data/gateways/market-data.gateway.spec.ts
git commit -m "feat(market-data): feed the owner's browser from the hub's prices behind HUB_SERVES_BROWSER" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/market-data/gateways/market-data.gateway.ts apps/api/src/modules/market-data/gateways/market-data.gateway.spec.ts
```

---

### Task 6: Quote, depth, indices and watchlist endpoints answer from the hub first

**Files:**
- Create: `apps/api/src/modules/market-hub/serve-browser.ts`
- Create: `apps/api/src/modules/market-hub/serve-browser.spec.ts`
- Modify: `apps/api/src/modules/market-data/services/batch-quotes.service.ts`
- Modify: `apps/api/src/modules/market-data/services/batch-quotes.service.spec.ts`
- Modify: `apps/api/src/modules/market-data/controllers/market-data.controller.ts`

**Interfaces:**
- Consumes: `HubPriceSource` (Task 1), `priceToQuote`, `priceToDepth`, `BROWSER_WATCH_TTL_MS`, `SCREEN_MAX_AGE_MS` (Task 3), `lookupHubPrices`; `MarketQuoteResolver.resolveQuotes`, `AngelOneAdapterService.getMarketDepth`, `UserFeedManager.fetchQuote` (legacy, unchanged).
- Produces:

```typescript
// serve-browser.ts
export interface BrowserQuoteRef { token: string; exchange: string; symbol?: string }
export interface HubQuotesServed<R extends BrowserQuoteRef> { quotes: Map<string, QuoteResponse>; missing: R[] }  // quotes keyed EXCHANGE:token
export const REST_OWNER: { quote: 'rest:quote'; depth: 'rest:depth'; indices: 'rest:indices'; watchlist: 'rest:watchlist' };
export function hubQuoteKey(token: string, exchange: string): string;          // `${exchange.toUpperCase()}:${token}`
export function serveQuotesFromHub<R extends BrowserQuoteRef>(
  source: HubPriceSource | null, userId: string, refs: readonly R[], watch: { priority: Priority; owner: string },
): HubQuotesServed<R>;                                                          // synchronous, never throws
export function serveDepthFromHub(source: HubPriceSource | null, userId: string, ref: BrowserQuoteRef): MarketDepth | null;  // null = legacy

// batch-quotes.service.ts
export interface HubTierAnswer { quotes: Map<string, QuoteResponse>; missing: QuoteRequestRef[] }
BatchQuotesService.getQuotes(userId, items?, hubTier?: (refs: QuoteRequestRef[]) => HubTierAnswer)

// market-data.controller.ts — response gains `source: 'hub'` when served by the hub
GET  /api/market-data/instruments/:token/quote   → hub (P4, rest:quote) → per-user fetchQuote → level book
GET  /api/market-data/instruments/:token/depth   → hub (P4, rest:depth, fresh only) → shared adapter
GET  /api/market-data/indices                    → hub (P2, rest:indices) → resolver for the misses
POST /api/market-data/quotes                     → hub (P3, rest:watchlist) → resolver for the misses
```

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/modules/market-hub/serve-browser.spec.ts`:

```typescript
import type { HubPriceSource, HubPrices } from './hub-prices';
import type { InstrumentRef, Price, PriceResult } from './hub.types';
import { REST_OWNER, hubQuoteKey, serveDepthFromHub, serveQuotesFromHub } from './serve-browser';

const AT = 1_760_000_000_000;
const price = (exchange: InstrumentRef['exchange'], token: string, ltp: number, extra: Partial<Price> = {}): Price => ({
  ref: { exchange, token, symbol: token },
  ltp,
  at: AT,
  source: 'ws',
  day: { open: ltp, high: ltp, low: ltp, close: ltp - 10 },
  ...extra,
});

function sourceWith(answers: Record<string, PriceResult>, owner = 'owner') {
  const hub: HubPrices = {
    price: jest.fn((ref: InstrumentRef): PriceResult => answers[`${ref.exchange}:${ref.token}`] ?? { kind: 'unavailable', reason: 'never-priced' }),
    prices: jest.fn(),
    watch: jest.fn().mockResolvedValue(undefined),
    unwatch: jest.fn().mockResolvedValue(undefined),
    onPrice: jest.fn(() => () => undefined),
  };
  const source: HubPriceSource = {
    hubFor: jest.fn((userId: string | null, consumer) => (consumer === 'browser' && userId === owner ? hub : null)),
    record: jest.fn(),
  };
  return { hub, source };
}

describe('serveQuotesFromHub', () => {
  it('serves fresh prices as quotes keyed EXCHANGE:token, watching every ref at the given priority with the screen TTL', () => {
    const { hub, source } = sourceWith({ 'NSE:2885': { kind: 'fresh', price: price('NSE', '2885', 1500) } });
    const out = serveQuotesFromHub(source, 'owner', [{ token: '2885', exchange: 'nse', symbol: 'RELIANCE' }], { priority: 3, owner: REST_OWNER.watchlist });
    expect(hub.watch).toHaveBeenCalledWith([{ exchange: 'NSE', token: '2885', symbol: 'RELIANCE' }], 3, 'rest:watchlist', 120_000);
    expect(hub.price).toHaveBeenCalledWith({ exchange: 'NSE', token: '2885', symbol: 'RELIANCE' }, { maxAgeMs: 15_000 });
    expect(out.missing).toEqual([]);
    expect(out.quotes.get(hubQuoteKey('2885', 'NSE'))).toMatchObject({ symbol: 'RELIANCE', ltp: 1500, close: 1490, change: 10 });
    expect(source.record).toHaveBeenCalledWith('browser', 'hub', 1);
    expect(source.record).toHaveBeenCalledWith('browser', 'legacy', 0);
  });

  it('a never-priced or stale instrument is missing (legacy), and a market-closed one is served with its own timestamp', () => {
    const { source } = sourceWith({
      'NSE:1': { kind: 'stale', price: price('NSE', '1', 10), ageMs: 60_000 },
      'MCX:3': { kind: 'market-closed', price: price('MCX', '3', 30) },
    });
    const refs = [
      { token: '1', exchange: 'NSE' },
      { token: '2', exchange: 'NSE' }, // never priced
      { token: '3', exchange: 'MCX' },
    ];
    const out = serveQuotesFromHub(source, 'owner', refs, { priority: 4, owner: REST_OWNER.quote });
    expect(out.missing).toEqual([refs[0], refs[1]]);
    expect(out.quotes.get('MCX:3')).toMatchObject({ ltp: 30, timestamp: new Date(AT) });
    expect(source.record).toHaveBeenCalledWith('browser', 'legacy', 2);
  });

  it('keys answers by EXCHANGE:token, so the same token on two exchanges is priced separately', () => {
    const { source } = sourceWith({
      'NSE:1594': { kind: 'fresh', price: price('NSE', '1594', 1700) },
      'MCX:1594': { kind: 'fresh', price: price('MCX', '1594', 7) },
    });
    const out = serveQuotesFromHub(source, 'owner', [{ token: '1594', exchange: 'NSE' }, { token: '1594', exchange: 'MCX' }], { priority: 3, owner: REST_OWNER.watchlist });
    expect(out.quotes.get('NSE:1594')?.ltp).toBe(1700);
    expect(out.quotes.get('MCX:1594')?.ltp).toBe(7);
  });

  it('an exchange the hub does not speak is missing, and never watched', () => {
    const { hub, source } = sourceWith({});
    const out = serveQuotesFromHub(source, 'owner', [{ token: '1', exchange: 'CDS' }], { priority: 4, owner: REST_OWNER.quote });
    expect(out.missing).toEqual([{ token: '1', exchange: 'CDS' }]);
    expect(hub.watch).not.toHaveBeenCalled();
  });

  it('serves nothing for a user hubFor does not serve, and counts nothing', () => {
    const { hub, source } = sourceWith({ 'NSE:2885': { kind: 'fresh', price: price('NSE', '2885', 1500) } });
    const refs = [{ token: '2885', exchange: 'NSE' }];
    expect(serveQuotesFromHub(source, 'someone-else', refs, { priority: 4, owner: REST_OWNER.quote })).toEqual({ quotes: new Map(), missing: refs });
    expect(serveQuotesFromHub(null, 'owner', refs, { priority: 4, owner: REST_OWNER.quote })).toEqual({ quotes: new Map(), missing: refs });
    expect(hub.price).not.toHaveBeenCalled();
    expect(source.record).not.toHaveBeenCalled();
  });

  it('never throws: a throwing hubFor or price() means every ref is missing', () => {
    const refs = [{ token: '2885', exchange: 'NSE' }];
    const boom: HubPriceSource = { hubFor: () => { throw new Error('boom'); }, record: jest.fn() };
    expect(serveQuotesFromHub(boom, 'owner', refs, { priority: 4, owner: REST_OWNER.quote }).missing).toEqual(refs);
    const { hub, source } = sourceWith({});
    (hub.price as jest.Mock).mockImplementation(() => { throw new Error('book'); });
    expect(serveQuotesFromHub(source, 'owner', refs, { priority: 4, owner: REST_OWNER.quote }).missing).toEqual(refs);
  });
});

describe('serveDepthFromHub', () => {
  const book = { bids: [{ price: 1499.9, qty: 10, orders: 2 }], asks: [{ price: 1500.1, qty: 4, orders: 1 }] };

  it('serves a fresh price’s book, watching the ref at priority 4', () => {
    const { hub, source } = sourceWith({ 'NSE:2885': { kind: 'fresh', price: price('NSE', '2885', 1500, { depth: book }) } });
    expect(serveDepthFromHub(source, 'owner', { token: '2885', exchange: 'NSE', symbol: 'RELIANCE' })).toEqual({
      token: '2885', exchange: 'NSE', bids: book.bids, asks: book.asks, totalBidQty: 10, totalAskQty: 4, ts: AT,
    });
    expect(hub.watch).toHaveBeenCalledWith([{ exchange: 'NSE', token: '2885', symbol: 'RELIANCE' }], 4, 'rest:depth', 120_000);
  });

  it('is null (legacy) for a market-closed or stale price, a price without a book, another user, or no hub', () => {
    const { source } = sourceWith({
      'NSE:1': { kind: 'market-closed', price: price('NSE', '1', 10, { depth: book }) },
      'NSE:2': { kind: 'stale', price: price('NSE', '2', 10, { depth: book }), ageMs: 30_000 },
      'NSE:3': { kind: 'fresh', price: price('NSE', '3', 10) },
    });
    expect(serveDepthFromHub(source, 'owner', { token: '1', exchange: 'NSE' })).toBeNull();
    expect(serveDepthFromHub(source, 'owner', { token: '2', exchange: 'NSE' })).toBeNull();
    expect(serveDepthFromHub(source, 'owner', { token: '3', exchange: 'NSE' })).toBeNull();
    expect(serveDepthFromHub(source, 'u2', { token: '1', exchange: 'NSE' })).toBeNull();
    expect(serveDepthFromHub(null, 'owner', { token: '1', exchange: 'NSE' })).toBeNull();
  });
});
```

Append inside the top-level `describe` of `batch-quotes.service.spec.ts` (it already has `quote()` and `fakeResolver()`; the service is built as `new BatchQuotesService(resolver)`):

```typescript
  it('the hub tier answers first and only the misses reach the resolver', async () => {
    const { resolver, calls } = fakeResolver({ '1333': quote({ token: '1333', ltp: 1600 }) });
    const svc = new BatchQuotesService(resolver);
    const hubTier = jest.fn((refs: QuoteRequestRef[]) => ({
      quotes: new Map([['NSE:2885', quote({ token: '2885', ltp: 1500, change: 5, changePercent: 0.3344 })]]),
      missing: refs.filter((r) => r.token !== '2885'),
    }));
    const out = await svc.getQuotes('owner', [{ token: '2885', exchange: 'nse' }, { token: '1333', exchange: 'NSE' }], hubTier);
    expect(hubTier).toHaveBeenCalledWith([{ token: '2885', exchange: 'NSE' }, { token: '1333', exchange: 'NSE' }]);
    expect(calls).toEqual([{ userId: 'owner', refs: [{ token: '1333', exchange: 'NSE' }] }]);
    expect(out.quotes.map((q) => [q.token, q.ltp, q.change])).toEqual([['2885', 1500, 5], ['1333', 1600, 5]]);
  });

  it('calls no resolver when the hub tier answered everything, and survives a throwing tier', async () => {
    const { resolver, calls } = fakeResolver({ '2885': quote({ token: '2885', ltp: 1490 }) });
    const svc = new BatchQuotesService(resolver);
    const all = await svc.getQuotes('owner', [{ token: '2885', exchange: 'NSE' }], () => ({
      quotes: new Map([['NSE:2885', quote({ token: '2885', ltp: 1500 })]]),
      missing: [],
    }));
    expect(calls).toEqual([]);
    expect(all.quotes[0].ltp).toBe(1500);
    const thrown = await svc.getQuotes('owner', [{ token: '2885', exchange: 'NSE' }], () => {
      throw new Error('hub down');
    });
    expect(thrown.quotes[0].ltp).toBe(1490);
  });
```

If `fakeResolver` in that file returns its parts under other names, adapt only the destructuring; keep the assertions.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @td/api test -- serve-browser.spec batch-quotes.service.spec`
Expected: FAIL. `Cannot find module './serve-browser'`; `getQuotes` ignores its third argument, so the resolver is called with both refs.

- [ ] **Step 3: Implement**

Create `apps/api/src/modules/market-hub/serve-browser.ts`:

```typescript
import type { MarketDepth } from '@td/shared/types';
import type { QuoteResponse } from '../market-data/utils/tick-to-quote';
import { BROWSER_WATCH_TTL_MS, SCREEN_MAX_AGE_MS, priceToDepth, priceToQuote } from './browser-feed';
import type { HubPriceSource } from './hub-prices';
import { isHubExchange, refKey, type InstrumentRef, type Priority } from './hub.types';

/** What a REST caller asks for: the controller's own ref shape. */
export interface BrowserQuoteRef {
  token: string;
  exchange: string;
  symbol?: string;
}

export interface HubQuotesServed<R extends BrowserQuoteRef> {
  /** Keyed EXCHANGE:token (hubQuoteKey), never the token alone. */
  quotes: Map<string, QuoteResponse>;
  /** Everything the hub did not answer: the caller's legacy path prices these. */
  missing: R[];
}

/** Watch owners for REST reads (one per endpoint; each read renews the 2-minute TTL). */
export const REST_OWNER = {
  quote: 'rest:quote',
  depth: 'rest:depth',
  indices: 'rest:indices',
  watchlist: 'rest:watchlist',
} as const;

export function hubQuoteKey(token: string, exchange: string): string {
  return `${exchange.toUpperCase()}:${token}`;
}

function toRef(req: BrowserQuoteRef): InstrumentRef | null {
  const exchange = req.exchange.toUpperCase();
  return isHubExchange(exchange) ? { exchange, token: req.token, symbol: req.symbol || req.token } : null;
}

/**
 * SP1 M4 hub tier for /quote, /indices and /quotes (the M2 serveChartFromHub
 * pattern). Only when hubFor(userId, 'browser') serves this user: watch every
 * ref (not awaited), then answer the ones the PriceBook has fresh within 15 s
 * or market-closed (last price, labelled by its timestamp). Everything else is
 * `missing`, for the caller's legacy path. Synchronous; never throws.
 */
export function serveQuotesFromHub<R extends BrowserQuoteRef>(
  source: HubPriceSource | null,
  userId: string,
  refs: readonly R[],
  watch: { priority: Priority; owner: string },
): HubQuotesServed<R> {
  const none = (): HubQuotesServed<R> => ({ quotes: new Map(), missing: [...refs] });
  try {
    const hub = source?.hubFor(userId, 'browser') ?? null;
    if (!source || !hub) return none();
    const valid: Array<{ req: R; ref: InstrumentRef }> = [];
    const missing: R[] = [];
    for (const req of refs) {
      const ref = toRef(req);
      if (ref) valid.push({ req, ref });
      else missing.push(req);
    }
    if (valid.length > 0) {
      void Promise.resolve(hub.watch(valid.map((v) => v.ref), watch.priority, watch.owner, BROWSER_WATCH_TTL_MS)).catch(() => undefined);
    }
    const quotes = new Map<string, QuoteResponse>();
    for (const { req, ref } of valid) {
      const r = hub.price(ref, { maxAgeMs: SCREEN_MAX_AGE_MS });
      if (r.kind === 'fresh' || r.kind === 'market-closed') quotes.set(refKey(ref), priceToQuote(r.price, req.symbol));
      else missing.push(req);
    }
    source.record('browser', 'hub', quotes.size);
    source.record('browser', 'legacy', missing.length);
    return { quotes, missing };
  } catch {
    return none();
  }
}

/** Hub tier for /depth: a FRESH price's book only (a closed market's book is meaningless). Null = legacy path. */
export function serveDepthFromHub(source: HubPriceSource | null, userId: string, req: BrowserQuoteRef): MarketDepth | null {
  try {
    const hub = source?.hubFor(userId, 'browser') ?? null;
    const ref = toRef(req);
    if (!source || !hub || !ref) return null;
    void Promise.resolve(hub.watch([ref], 4, REST_OWNER.depth, BROWSER_WATCH_TTL_MS)).catch(() => undefined);
    const r = hub.price(ref, { maxAgeMs: SCREEN_MAX_AGE_MS });
    const depth = r.kind === 'fresh' ? priceToDepth(r.price) : null;
    source.record('browser', depth ? 'hub' : 'legacy');
    return depth;
  } catch {
    return null;
  }
}
```

In `batch-quotes.service.ts`:
- after `interface QuoteResolverLike`, add:

```typescript
/** SP1 M4: what the hub answered (keyed EXCHANGE:token) and what is left for the resolver. */
export interface HubTierAnswer {
  quotes: Map<string, QuoteResponse>;
  missing: QuoteRequestRef[];
}
```

- replace the `getQuotes` method (its doc comment's `@param` lines gain `@param hubTier`) with:

```typescript
  /**
   * @param userId  owner of the Angel session the quotes are fetched over
   * @param items   instruments to quote; malformed entries are dropped
   * @param hubTier SP1 M4: answers what the hub has first; only its misses reach the resolver
   * @returns `{ quotes, count }` — `count` is `quotes.length`, kept because the
   *          old handler returned it (harmless for the frontend, which reads
   *          only `quotes`).
   */
  async getQuotes(
    userId: string,
    items?: { token: string; exchange: string }[] | null,
    hubTier?: (refs: QuoteRequestRef[]) => HubTierAnswer,
  ): Promise<{ quotes: QuoteRow[]; count: number }> {
    const refs = normalizeRefs(items);
    // Short-circuit: an empty watchlist must never reach the broker.
    if (refs.length === 0) return { quotes: [], count: 0 };

    let tier: HubTierAnswer = { quotes: new Map(), missing: refs };
    if (hubTier) {
      try {
        tier = hubTier(refs);
      } catch {
        // A failing hub tier is the legacy path, never an empty watchlist.
      }
    }
    const resolved =
      tier.missing.length > 0
        ? await this.resolver.resolveQuotes(userId, tier.missing)
        : new Map<string, QuoteResponse>();
    const quotes: QuoteRow[] = [];

    for (const ref of refs) {
      const q = tier.quotes.get(`${ref.exchange.toUpperCase()}:${ref.token}`) ?? resolved?.get(ref.token);
      if (!q) continue; // unquotable token — omit the row, per the contract
      quotes.push({
        token: ref.token,
        // Echo the exchange the CALLER asked for, not the resolver's, so the
        // row always lines up with the watchlist entry that requested it.
        exchange: ref.exchange,
        ltp: finite(q.ltp),
        open: finite(q.open),
        high: finite(q.high),
        low: finite(q.low),
        close: finite(q.close),
        volume: finite(q.volume),
        change: round2(q.change),
        changePercent: round2(q.changePercent),
      });
    }

    return { quotes, count: quotes.length };
  }
```

In `market-data.controller.ts`:
- add imports after the `serve-chart` import:

```typescript
import { lookupHubPrices, type HubPriceSource } from '../../market-hub/hub-prices';
import { REST_OWNER, hubQuoteKey, serveDepthFromHub, serveQuotesFromHub } from '../../market-hub/serve-browser';
```

- after `hubCandleSource()`, add:

```typescript
  /** SP1 M4: the hub's price source, if this container has the market hub (lazy: no module cycle). */
  private hubPriceSource(): HubPriceSource | null {
    return lookupHubPrices(this.moduleRef);
  }
```

- in `getQuote`, directly after `const resolvedSymbol = instrument?.symbol ?? constantEntry?.symbol ?? '';`, insert:

```typescript
    // SP1 M4 (HUB_SERVES_BROWSER): the owner's quote comes from the hub's PriceBook
    // (fresh ≤ 15 s, or the labelled last price when the exchange is closed).
    const fromHub = serveQuotesFromHub(
      this.hubPriceSource(),
      userId,
      [{ token, exchange: resolvedExchange, symbol: resolvedSymbol || undefined }],
      { priority: 4, owner: REST_OWNER.quote },
    );
    const hubQuote = fromHub.quotes.get(hubQuoteKey(token, resolvedExchange));
    if (hubQuote) return { token, quote: hubQuote, source: 'hub' as const };
```

- replace `getDepth` with:

```typescript
  @Get('instruments/:token/depth')
  @ApiOperation({ summary: 'Get 5-level market depth for an instrument' })
  @ApiParam({ name: 'token', description: 'Instrument token' })
  @ApiQuery({ name: 'exchange', required: true })
  async getDepth(
    @Param('token') token: string,
    @Query('exchange') exchange: string,
    @CurrentUser('userId') userId: string,
  ) {
    if (!exchange) {
      throw new BadRequestException('exchange query parameter is required');
    }
    // SP1 M4: the owner's book comes from the hub (SNAP_QUOTE ticks / FULL quotes), fresh only.
    const fromHub = serveDepthFromHub(this.hubPriceSource(), userId, {
      token,
      exchange,
      symbol: resolveTokenFromConstants(token)?.symbol,
    });
    if (fromHub) return { depth: fromHub, source: 'hub' as const };
    const depth = await this.angelOneAdapter.getMarketDepth(token, exchange);
    return { depth };
  }
```

- replace `getIndices` with:

```typescript
  @Get('indices')
  @ApiOperation({ summary: 'Get major market indices with live data' })
  async getIndices(@CurrentUser('userId') userId: string) {
    const indices = this.instrumentService.getIndices();
    const refs = indices.map((idx) => ({ token: idx.token, exchange: idx.exchange, symbol: idx.symbol }));

    // SP1 M4: the hub answers what it has (market context is watched at priority 2);
    // only the misses go to the resolver (batched broker quotes + daily-candle fallback
    // for the NSE index tokens Angel refuses to quote).
    const fromHub = serveQuotesFromHub(this.hubPriceSource(), userId, refs, {
      priority: 2,
      owner: REST_OWNER.indices,
    });
    const resolved =
      fromHub.missing.length > 0
        ? await this.marketQuoteResolver.resolveQuotes(userId, fromHub.missing)
        : new Map();

    return {
      indices: indices.map((idx) => ({
        key: idx.key,
        symbol: idx.symbol,
        token: idx.token,
        exchange: idx.exchange,
        quote: fromHub.quotes.get(hubQuoteKey(idx.token, idx.exchange)) ?? resolved.get(idx.token) ?? null,
      })),
    };
  }
```

- replace the body of `getQuotes` with:

```typescript
    // SP1 M4: hub first (watchlist rows watched at priority 3); the resolver prices the rest.
    return this.batchQuotes.getQuotes(userId, body?.items, (refs) =>
      serveQuotesFromHub(this.hubPriceSource(), userId, refs, { priority: 3, owner: REST_OWNER.watchlist }),
    );
```

- in the `getDepth` doc comment, replace `(polled every 2s on the frontend; adapter caches at 1.5s so we don't hammer SmartAPI)` with `(hub-first for the owner; the browser polls it only when its feed is not hub-served and Live)`.

- [ ] **Step 4: Run tests to verify they pass, including the architecture ratchet**

Run: `pnpm --filter @td/api test -- serve-browser.spec batch-quotes.service.spec market-page-wiring.spec market-quote-resolver.service.spec only-door.spec`
Expected: PASS. The controller is still in `KNOWN_VIOLATORS` for its debug `getCandleData` endpoint (M6); no new violator.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/market-hub/serve-browser.ts apps/api/src/modules/market-hub/serve-browser.spec.ts apps/api/src/modules/market-data/services/batch-quotes.service.ts apps/api/src/modules/market-data/services/batch-quotes.service.spec.ts apps/api/src/modules/market-data/controllers/market-data.controller.ts
git commit -m "feat(market-data): quote, depth, indices and watchlist endpoints answer from the hub first" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/market-hub/serve-browser.ts apps/api/src/modules/market-hub/serve-browser.spec.ts apps/api/src/modules/market-data/services/batch-quotes.service.ts apps/api/src/modules/market-data/services/batch-quotes.service.spec.ts apps/api/src/modules/market-data/controllers/market-data.controller.ts
```

---

### Task 7: Web wire contract: exchange-aware, ref-counted subscriptions and `feed-source`

**Files:**
- Create: `apps/web/src/services/browser-feed.ts`
- Create: `apps/web/src/services/browser-feed.spec.ts`
- Modify: `apps/web/src/services/websocket.ts`
- Modify: `apps/web/src/services/websocket.spec.ts`
- Create: `apps/web/src/services/websocket.subscribe.spec.ts`
- Modify: `apps/web/src/stores/market-store.ts`
- Create: `apps/web/src/hooks/useLivePollMs.ts`
- Modify: `apps/web/src/hooks/useChartData.ts` (subscription delta only; the live edge is Task 9)
- Modify: `apps/web/src/hooks/useChartData.subscribe.spec.ts`

**Interfaces:**
- Consumes: the gateway's `subscribe`/`unsubscribe` body (`{ tokens, refs, purpose }`) and `feed-source` event (Tasks 4–5); `FeedHealth` (`feed-health.ts`).
- Produces:

```typescript
// services/browser-feed.ts
export type FeedPurpose = 'chart' | 'watchlist' | 'context';
export type FeedSource = 'hub' | 'legacy';
export interface FeedRef { token: string; exchange: string; symbol?: string }
export function feedKey(r: Pick<FeedRef, 'token' | 'exchange'>): string;        // 'NFO:35001'
export function isFeedSource(x: unknown): x is FeedSource;
export interface WireDepthLevel { price: number; qty: number; orders: number }
export interface WireTick { token; symbol; exchange?; ltp; open; high; low; close; volume; oi?; timestamp: string; at?; source?; change?; changePercent?; depth?: { bids: WireDepthLevel[]; asks: WireDepthLevel[] } }
export function tickMatches(tick: unknown, token: string, exchange: string): tick is WireTick;
export function livePollMs(baseMs: number, feed: { source: FeedSource | null; health: FeedHealth }): number | false;

// services/websocket.ts
export function toSubscribePayload(refs: FeedRef[], purpose?: FeedPurpose): { tokens: string[]; refs: FeedRef[]; purpose?: FeedPurpose };
export function replayPayloads(entries: Iterable<{ ref: FeedRef; purpose: FeedPurpose }>): Array<ReturnType<typeof toSubscribePayload>>;
wsService.emitSubscribe(refs: FeedRef[], purpose?: FeedPurpose): void      // ref-counted per EXCHANGE:token
wsService.emitUnsubscribe(refs: FeedRef[]): void
wsService.getFeedSource(): FeedSource | null
// WSEventName gains 'feed-source'

// stores/market-store.ts
feedSource: FeedSource | null; setFeedSource(source: FeedSource | null): void

// hooks/useLivePollMs.ts
export function useLivePollMs(baseMs: number): number | false;

// hooks/useChartData.ts
export function computeSubscriptionDelta(prev: FeedRef | null, next: FeedRef | null): { add: FeedRef[]; remove: FeedRef[] };
```

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/services/browser-feed.spec.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { feedKey, isFeedSource, livePollMs, tickMatches } from './browser-feed';

describe('feedKey', () => {
  it('is EXCHANGE:token, upper-cased, never the token alone', () => {
    expect(feedKey({ token: '35001', exchange: 'nfo' })).toBe('NFO:35001');
    expect(feedKey({ token: '1594', exchange: 'NSE' })).not.toBe(feedKey({ token: '1594', exchange: 'MCX' }));
  });
});

describe('livePollMs', () => {
  it('is off only for a hub-served, Live feed', () => {
    expect(livePollMs(3000, { source: 'hub', health: 'live' })).toBe(false);
  });

  it('keeps today’s cadence as the fallback for a stale or offline hub feed, a legacy feed, or before the server said', () => {
    expect(livePollMs(3000, { source: 'hub', health: 'stale' })).toBe(3000);
    expect(livePollMs(3000, { source: 'hub', health: 'offline' })).toBe(3000);
    expect(livePollMs(2000, { source: 'legacy', health: 'live' })).toBe(2000);
    expect(livePollMs(5000, { source: null, health: 'live' })).toBe(5000);
  });
});

describe('tickMatches', () => {
  const tick = { token: '35001', exchange: 'NFO', symbol: 'X', ltp: 1, open: 0, high: 0, low: 0, close: 0, volume: 0, timestamp: '' };

  it('needs the token to agree, and the exchange to agree when the tick has one', () => {
    expect(tickMatches(tick, '35001', 'NFO')).toBe(true);
    expect(tickMatches(tick, '35001', 'nfo')).toBe(true);
    expect(tickMatches(tick, '35001', 'MCX')).toBe(false);
    expect(tickMatches(tick, '35002', 'NFO')).toBe(false);
  });

  it('a tick without an exchange (an old server) matches on token alone; junk never matches', () => {
    const bare = { ...tick, exchange: undefined };
    expect(tickMatches(bare, '35001', 'NFO')).toBe(true);
    expect(tickMatches(null, '35001', 'NFO')).toBe(false);
    expect(tickMatches('tick', '35001', 'NFO')).toBe(false);
  });
});

describe('isFeedSource', () => {
  it('accepts only hub and legacy', () => {
    expect(isFeedSource('hub')).toBe(true);
    expect(isFeedSource('legacy')).toBe(true);
    expect(isFeedSource('HUB')).toBe(false);
    expect(isFeedSource(undefined)).toBe(false);
  });
});
```

Replace `apps/web/src/services/websocket.spec.ts` with:

```typescript
import { describe, expect, it } from 'vitest';
import { buildHandshakeAuth, replayPayloads, toSubscribePayload } from './websocket';

describe('buildHandshakeAuth', () => {
  it('builds handshake auth from a token', () => {
    expect(buildHandshakeAuth('abc')).toEqual({ token: 'abc' });
  });

  it('passes through an empty token unchanged', () => {
    expect(buildHandshakeAuth('')).toEqual({ token: '' });
  });
});

describe('toSubscribePayload', () => {
  it('sends refs with their exchange (upper-cased) and purpose, plus bare tokens for an old server', () => {
    expect(toSubscribePayload([{ token: '35001', exchange: 'nfo', symbol: 'NIFTY26OCT25000CE' }, { token: '2885', exchange: 'NSE' }], 'chart')).toEqual({
      tokens: ['35001', '2885'],
      refs: [
        { token: '35001', exchange: 'NFO', symbol: 'NIFTY26OCT25000CE' },
        { token: '2885', exchange: 'NSE' },
      ],
      purpose: 'chart',
    });
  });

  it('omits the purpose when none is given (unsubscribe)', () => {
    expect(toSubscribePayload([])).toEqual({ tokens: [], refs: [] });
  });
});

describe('replayPayloads', () => {
  it('groups every held subscription by purpose, one payload each', () => {
    expect(
      replayPayloads([
        { ref: { token: '1', exchange: 'NSE' }, purpose: 'watchlist' },
        { ref: { token: '2', exchange: 'NFO' }, purpose: 'chart' },
        { ref: { token: '3', exchange: 'NSE' }, purpose: 'watchlist' },
      ]),
    ).toEqual([
      { tokens: ['1', '3'], refs: [{ token: '1', exchange: 'NSE' }, { token: '3', exchange: 'NSE' }], purpose: 'watchlist' },
      { tokens: ['2'], refs: [{ token: '2', exchange: 'NFO' }], purpose: 'chart' },
    ]);
  });
});
```

Create `apps/web/src/services/websocket.subscribe.spec.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCESS_TOKEN_KEY } from './auth-storage';

/** Same fake-socket harness as websocket.connect-gate.spec.ts. */
interface FakeSocket {
  on: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  connected: boolean;
  io: { engine: { transport: { name: string }; on: ReturnType<typeof vi.fn> } };
}

const sockets: FakeSocket[] = [];
const ioMock = vi.fn(() => {
  const s: FakeSocket = {
    on: vi.fn(),
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    connected: false,
    io: { engine: { transport: { name: 'websocket' }, on: vi.fn() } },
  };
  sockets.push(s);
  return s;
});
vi.mock('socket.io-client', () => ({ io: (...args: unknown[]) => ioMock(...(args as [])) }));

function installBrowserGlobals(): void {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  vi.stubGlobal('window', {});
}

/** Fire a handler the service registered on a fake socket with `sock.on(event, fn)`. */
function fire(sock: FakeSocket, event: string, payload?: unknown): void {
  const call = sock.on.mock.calls.find(([e]) => e === event);
  if (!call) throw new Error(`no ${event} handler`);
  (call[1] as (p?: unknown) => void)(payload);
}

describe('wsService subscriptions', () => {
  let wsService: typeof import('./websocket').wsService;

  beforeEach(async () => {
    sockets.length = 0;
    ioMock.mockClear();
    installBrowserGlobals();
    localStorage.setItem(ACCESS_TOKEN_KEY, 'jwt');
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.resetModules();
    ({ wsService } = await import('./websocket'));
  });

  afterEach(() => {
    wsService.disconnect();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('ref-counts subscriptions: one emit per new ref, one unsubscribe when the last holder releases', () => {
    wsService.connect();
    const ws = sockets[0]; // '/ws' is the first namespace
    wsService.emitSubscribe([{ token: '35001', exchange: 'nfo', symbol: 'NIFTY26OCT25000CE' }], 'chart');
    wsService.emitSubscribe([{ token: '35001', exchange: 'NFO' }], 'watchlist'); // a second holder: no emit
    expect(ws.emit.mock.calls).toEqual([
      ['subscribe', { tokens: ['35001'], refs: [{ token: '35001', exchange: 'NFO', symbol: 'NIFTY26OCT25000CE' }], purpose: 'chart' }],
    ]);
    wsService.emitUnsubscribe([{ token: '35001', exchange: 'NFO' }]);
    expect(ws.emit).toHaveBeenCalledTimes(1); // still held by the other hook
    wsService.emitUnsubscribe([{ token: '35001', exchange: 'NFO' }]);
    expect(ws.emit).toHaveBeenLastCalledWith('unsubscribe', {
      tokens: ['35001'],
      refs: [{ token: '35001', exchange: 'NFO', symbol: 'NIFTY26OCT25000CE' }],
    });
    wsService.emitUnsubscribe([{ token: '35001', exchange: 'NFO' }]); // over-release is a no-op
    expect(ws.emit).toHaveBeenCalledTimes(2);
  });

  it('the same token on two exchanges is two subscriptions', () => {
    wsService.connect();
    const ws = sockets[0];
    wsService.emitSubscribe([{ token: '1594', exchange: 'NSE' }, { token: '1594', exchange: 'MCX' }], 'watchlist');
    expect(ws.emit).toHaveBeenCalledWith('subscribe', {
      tokens: ['1594', '1594'],
      refs: [{ token: '1594', exchange: 'NSE' }, { token: '1594', exchange: 'MCX' }],
      purpose: 'watchlist',
    });
  });

  it('replays every subscription, grouped by purpose, when /ws reconnects', () => {
    wsService.emitSubscribe([{ token: '2885', exchange: 'NSE' }], 'watchlist'); // before connect: remembered
    wsService.emitSubscribe([{ token: '35001', exchange: 'NFO' }], 'chart');
    wsService.connect();
    const ws = sockets[0];
    fire(ws, 'connect');
    expect(ws.emit.mock.calls).toEqual([
      ['subscribe', { tokens: ['2885'], refs: [{ token: '2885', exchange: 'NSE' }], purpose: 'watchlist' }],
      ['subscribe', { tokens: ['35001'], refs: [{ token: '35001', exchange: 'NFO' }], purpose: 'chart' }],
    ]);
  });

  it('remembers the server’s feed-source and forwards it to subscribers; junk is ignored', () => {
    wsService.connect();
    const ws = sockets[0];
    const seen: unknown[] = [];
    wsService.subscribe('feed-source', (d) => seen.push(d));
    expect(wsService.getFeedSource()).toBeNull();
    fire(ws, 'feed-source', { source: 'hub' });
    expect(wsService.getFeedSource()).toBe('hub');
    fire(ws, 'feed-source', { source: 'bogus' });
    expect(wsService.getFeedSource()).toBe('hub');
    expect(seen).toEqual([{ source: 'hub' }, { source: 'bogus' }]);
  });
});
```

Replace `apps/web/src/hooks/useChartData.subscribe.spec.ts` with:

```typescript
import { describe, it, expect } from 'vitest';
import { computeSubscriptionDelta } from './useChartData';

const A = { token: '111', exchange: 'NSE', symbol: 'AAA' };
const B = { token: '222', exchange: 'NSE' };

describe('computeSubscriptionDelta', () => {
  it('computes refs to add and remove on symbol switch', () => {
    expect(computeSubscriptionDelta(A, B)).toEqual({ add: [B], remove: [A] });
    expect(computeSubscriptionDelta(null, B)).toEqual({ add: [B], remove: [] });
    expect(computeSubscriptionDelta(B, { ...B })).toEqual({ add: [], remove: [] });
  });

  it('the same token on another exchange is a switch, not a no-op', () => {
    const A_MCX = { token: '111', exchange: 'MCX' };
    expect(computeSubscriptionDelta(A, A_MCX)).toEqual({ add: [A_MCX], remove: [A] });
  });

  it('a change of case or symbol only is a no-op', () => {
    expect(computeSubscriptionDelta(A, { token: '111', exchange: 'nse', symbol: 'other' })).toEqual({ add: [], remove: [] });
  });

  it('removes the previous ref when switching to none, and is a no-op when both are null', () => {
    expect(computeSubscriptionDelta(A, null)).toEqual({ add: [], remove: [A] });
    expect(computeSubscriptionDelta(null, null)).toEqual({ add: [], remove: [] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @td/web test -- browser-feed websocket useChartData.subscribe`
Expected: FAIL. `Failed to resolve import "./browser-feed"`; `replayPayloads` is not exported; `toSubscribePayload` returns `{ tokens: [{…}] }`; `wsService.getFeedSource is not a function`; `computeSubscriptionDelta(A, B)` compares objects by identity.

- [ ] **Step 3: Implement**

Create `apps/web/src/services/browser-feed.ts`:

```typescript
import type { FeedHealth } from './feed-health';

/**
 * SP1 M4: the browser side of the hub feed. Pure, so every rule a hook follows
 * (poll or not, which tick is mine) is asserted directly — the project's vitest
 * runs in node with no DOM renderer, so hooks are thin wiring of these.
 */

/** Why a screen wants an instrument. The server maps it to a hub priority (context 2, watchlist 3, chart 4). */
export type FeedPurpose = 'chart' | 'watchlist' | 'context';

/** Which path feeds this browser, as the /ws gateway says on connect. */
export type FeedSource = 'hub' | 'legacy';

/** One instrument on the feed. Exchange is required: tokens collide across exchanges. */
export interface FeedRef {
  token: string;
  exchange: string;
  symbol?: string;
}

export function feedKey(r: Pick<FeedRef, 'token' | 'exchange'>): string {
  return `${r.exchange.toUpperCase()}:${r.token}`;
}

export function isFeedSource(x: unknown): x is FeedSource {
  return x === 'hub' || x === 'legacy';
}

export interface WireDepthLevel {
  price: number;
  qty: number;
  orders: number;
}

/**
 * The `/ws` `tick` payload. Legacy ticks are the server's `TickData`; hub ticks
 * add `exchange`, `at`, `source`, `depth`, and `change`/`changePercent` when the
 * broker reported the previous close. `timestamp` is an ISO string on the wire.
 */
export interface WireTick {
  token: string;
  symbol: string;
  exchange?: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi?: number;
  timestamp: string;
  at?: number;
  source?: 'ws' | 'quote' | 'db';
  change?: number;
  changePercent?: number;
  depth?: { bids: WireDepthLevel[]; asks: WireDepthLevel[] };
}

/** Is this tick for (token, exchange)? The exchange must agree whenever the tick carries one. */
export function tickMatches(tick: unknown, token: string, exchange: string): tick is WireTick {
  if (!tick || typeof tick !== 'object') return false;
  const t = tick as Partial<WireTick>;
  if (t.token !== token) return false;
  return !t.exchange || t.exchange.toUpperCase() === exchange.toUpperCase();
}

/**
 * The poll interval for a screen, or `false` for "do not poll".
 *
 * Off only while the hub feeds this browser AND the tick feed is Live: then
 * every number arrives as a tick. Any other state — the socket down, no tick
 * for 6 s, a legacy user, or the server not having said yet — keeps today's
 * cadence, so a stall can never freeze a screen.
 */
export function livePollMs(baseMs: number, feed: { source: FeedSource | null; health: FeedHealth }): number | false {
  return feed.source === 'hub' && feed.health === 'live' ? false : baseMs;
}
```

In `apps/web/src/services/websocket.ts`:
- add after the `feed-health` import:

```typescript
import { feedKey, isFeedSource, type FeedPurpose, type FeedRef, type FeedSource } from './browser-feed';
```

- replace `toSubscribePayload` and its comment with:

```typescript
/**
 * Shape the outbound `subscribe`/`unsubscribe` message body. `refs` carry the
 * exchange (the server no longer guesses NSE); bare `tokens` stay for an older
 * server. `purpose` decides the hub priority server-side. Pure by design.
 */
export function toSubscribePayload(
  refs: FeedRef[],
  purpose?: FeedPurpose,
): { tokens: string[]; refs: FeedRef[]; purpose?: FeedPurpose } {
  const clean = refs.map((r) => ({
    token: r.token,
    exchange: r.exchange.toUpperCase(),
    ...(r.symbol ? { symbol: r.symbol } : {}),
  }));
  return { tokens: clean.map((r) => r.token), refs: clean, ...(purpose ? { purpose } : {}) };
}

/** Every held subscription as one `subscribe` payload per purpose (reconnect replay). Pure. */
export function replayPayloads(
  entries: Iterable<{ ref: FeedRef; purpose: FeedPurpose }>,
): Array<ReturnType<typeof toSubscribePayload>> {
  const byPurpose = new Map<FeedPurpose, FeedRef[]>();
  for (const { ref, purpose } of entries) {
    const list = byPurpose.get(purpose);
    if (list) list.push(ref);
    else byPurpose.set(purpose, [ref]);
  }
  return [...byPurpose].map(([purpose, refs]) => toSubscribePayload(refs, purpose));
}
```

- in `WSEventName`, after `| 'feed-state'` add `| 'feed-source'`; in `NAMESPACES`, change the `/ws` events to `['tick', 'signal', 'alert', 'candle', 'feed-state', 'feed-source']`.
- replace the `subscribedTokens` field and its comment with:

```typescript
  /**
   * Instruments the app asked the server to stream on /ws, ref-counted per
   * EXCHANGE:token so one hook's release never drops another hook's symbol.
   * Held so we can re-emit `subscribe` after a reconnect (the server forgets on
   * disconnect). Bounded by the distinct refs the open screens asked for.
   */
  private subscriptions = new Map<string, { ref: FeedRef; purpose: FeedPurpose; count: number }>();
  /** What the /ws gateway said feeds this browser; null until it says. */
  private feedSource: FeedSource | null = null;
```

- in the `connect` handler, replace the replay block

```typescript
          if (this.subscribedTokens.size > 0) {
            sock.emit(
              'subscribe',
              toSubscribePayload([...this.subscribedTokens]),
            );
          }
```

with

```typescript
          for (const payload of replayPayloads(this.subscriptions.values())) {
            sock.emit('subscribe', payload);
          }
```

- in the per-event loop, replace `if (event === 'tick') this.lastTickAt = Date.now();` with:

```typescript
          if (event === 'tick') this.lastTickAt = Date.now();
          if (event === 'feed-source') {
            const source = (data as { source?: unknown } | null)?.source;
            if (isFeedSource(source)) this.feedSource = source;
          }
```

- in the client report, replace `subscribedTokens: this.subscribedTokens.size,` with `subscribedTokens: this.subscriptions.size,`.
- in `disconnect()`, after `this.lastHealth = 'live';` add `this.feedSource = null;`.
- replace `emitSubscribe` and `emitUnsubscribe` with:

```typescript
  /**
   * Ask the server to stream `refs` on /ws for `purpose`. Ref-counted: only a
   * ref no other caller holds is sent. Remembered for reconnect replay. Safe to
   * call before connect() — they are sent once /ws comes up.
   */
  emitSubscribe(refs: FeedRef[], purpose: FeedPurpose = 'chart'): void {
    const fresh: FeedRef[] = [];
    for (const ref of refs) {
      const key = feedKey(ref);
      const held = this.subscriptions.get(key);
      if (held) {
        held.count++;
        continue;
      }
      this.subscriptions.set(key, { ref, purpose, count: 1 });
      fresh.push(ref);
    }
    if (fresh.length > 0) this.sockets.get('/ws')?.emit('subscribe', toSubscribePayload(fresh, purpose));
  }

  /** Release `refs`; the server is told only when the last holder lets go. */
  emitUnsubscribe(refs: FeedRef[]): void {
    const gone: FeedRef[] = [];
    for (const ref of refs) {
      const key = feedKey(ref);
      const held = this.subscriptions.get(key);
      if (!held) continue;
      if (--held.count > 0) continue;
      this.subscriptions.delete(key);
      gone.push(held.ref);
    }
    if (gone.length > 0) this.sockets.get('/ws')?.emit('unsubscribe', toSubscribePayload(gone));
  }

  /** 'hub' when the server feeds this browser from the market hub; null until it says. */
  getFeedSource(): FeedSource | null {
    return this.feedSource;
  }
```

In `apps/web/src/stores/market-store.ts`:
- add `import type { FeedSource } from '@/services/browser-feed';`;
- in `MarketState`, after `feedHealth: FeedHealth;` add:

```typescript
  /** Which path feeds this browser ('hub' lets screens stop polling while Live); null until the server says. */
  feedSource: FeedSource | null;
```

  and after `setFeedHealth: (health: FeedHealth) => void;` add `setFeedSource: (source: FeedSource | null) => void;`;
- in the store body, after `feedHealth: 'offline',` add `feedSource: null,`, and after the `setFeedHealth` line add `setFeedSource: (source) => set({ feedSource: source }),`.

Create `apps/web/src/hooks/useLivePollMs.ts`:

```typescript
import { useMarketStore } from '@/stores/market-store';
import { livePollMs } from '@/services/browser-feed';

/** The store-backed {@link livePollMs}: `false` while the hub feeds this browser and the feed is Live. */
export function useLivePollMs(baseMs: number): number | false {
  const source = useMarketStore((s) => s.feedSource);
  const health = useMarketStore((s) => s.feedHealth);
  return livePollMs(baseMs, { source, health });
}
```

In `apps/web/src/hooks/useChartData.ts`:
- add `import { feedKey, type FeedRef } from '@/services/browser-feed';` after the `wsService` import;
- replace `computeSubscriptionDelta` and its comment with:

```typescript
/**
 * Pure diff of the chart's single-instrument subscription across a symbol
 * switch, compared by EXCHANGE:token (the same token on another exchange is a
 * different instrument). One add + one remove per switch; null means none.
 */
export function computeSubscriptionDelta(
  prev: FeedRef | null,
  next: FeedRef | null,
): { add: FeedRef[]; remove: FeedRef[] } {
  if ((prev ? feedKey(prev) : null) === (next ? feedKey(next) : null)) return { add: [], remove: [] };
  return {
    add: next ? [next] : [],
    remove: prev ? [prev] : [],
  };
}
```

- replace `const subscribedTokenRef = useRef<string | null>(null);` (and its comment) with:

```typescript
  // The instrument currently subscribed on the server feed (exchange-aware).
  const subscribedRef = useRef<FeedRef | null>(null);
```

- replace the "Drive the per-user server feed" effect and the unmount-cleanup effect with:

```typescript
  // Drive the server feed: exactly one unsubscribe (old) + one subscribe (new)
  // per symbol switch, with the exchange, as a viewed chart (hub priority 4).
  useEffect(() => {
    const { token, exchange, symbol } = selectedSymbol;
    const next: FeedRef | null = token && token !== '0' && exchange ? { token, exchange, symbol } : null;
    const delta = computeSubscriptionDelta(subscribedRef.current, next);
    if (delta.remove.length > 0) wsService.emitUnsubscribe(delta.remove);
    if (delta.add.length > 0) wsService.emitSubscribe(delta.add, 'chart');
    subscribedRef.current = next;
  }, [selectedSymbol.token, selectedSymbol.exchange, selectedSymbol.symbol]);

  // Unmount cleanup: release the instrument so the subscription does not leak.
  // Separate empty-deps effect so it fires ONLY on unmount (a symbol switch is
  // handled by the delta effect above). Reads the live ref.
  useEffect(() => {
    return () => {
      if (subscribedRef.current) {
        wsService.emitUnsubscribe([subscribedRef.current]);
      }
    };
  }, []);
```

If `react-hooks/exhaustive-deps` flags the delta effect's `selectedSymbol` destructuring, read the three fields as `selectedSymbol.token`, `selectedSymbol.exchange`, `selectedSymbol.symbol` instead; the deps stay the same.

- [ ] **Step 4: Run tests and the web typecheck**

Run: `pnpm --filter @td/web test -- browser-feed websocket useChartData`
Expected: PASS (`websocket.connect-gate.spec` included).
Run: `pnpm --filter @td/web exec tsc --noEmit -p tsconfig.json`
Expected: no errors. `useChartData` was the only caller of `emitSubscribe`/`emitUnsubscribe`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/services/browser-feed.ts apps/web/src/services/browser-feed.spec.ts apps/web/src/services/websocket.ts apps/web/src/services/websocket.spec.ts apps/web/src/services/websocket.subscribe.spec.ts apps/web/src/stores/market-store.ts apps/web/src/hooks/useLivePollMs.ts apps/web/src/hooks/useChartData.ts apps/web/src/hooks/useChartData.subscribe.spec.ts
git commit -m "feat(web): exchange-aware ref-counted feed subscriptions and the server's feed-source" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/web/src/services/browser-feed.ts apps/web/src/services/browser-feed.spec.ts apps/web/src/services/websocket.ts apps/web/src/services/websocket.spec.ts apps/web/src/services/websocket.subscribe.spec.ts apps/web/src/stores/market-store.ts apps/web/src/hooks/useLivePollMs.ts apps/web/src/hooks/useChartData.ts apps/web/src/hooks/useChartData.subscribe.spec.ts
```

---

### Task 8: Quote, depth, indices and watchlist screens on ticks; polls only as the fallback

**Files:**
- Modify: `apps/web/src/services/browser-feed.ts`
- Modify: `apps/web/src/services/browser-feed.spec.ts`
- Modify: `apps/web/src/hooks/useInstrumentQuote.ts` (full file below)
- Modify: `apps/web/src/hooks/useMarketDepth.ts` (full file below)
- Modify: `apps/web/src/hooks/useMarketData.ts` (full file below)
- Modify: `apps/web/src/hooks/useWatchlistQuotes.ts` (full file below)

**Interfaces:**
- Consumes: `wsService.emitSubscribe/emitUnsubscribe/subscribe/getFeedSource`, `useLivePollMs`, `tickMatches`, `isFeedSource`, `feedKey` (Task 7); the hub `tick` payload (Task 5); `GET /quote`, `GET /depth`, `GET /indices`, `POST /quotes` (Task 6, unchanged contracts).
- Produces:

```typescript
// services/browser-feed.ts
export interface QuoteFields { ltp: number; open: number; high: number; low: number; close: number; change: number; changePct: number }
export function quoteFromTick<T extends QuoteFields>(prev: T, tick: WireTick): T;     // same reference when the tick has no usable LTP
export function depthFromTick(tick: WireTick): MarketDepth | undefined;               // undefined when the tick carries no book
export function quoteForItem(item: { symbol: string; token: string; exchange: string }, tick: WireTick): Quote | null;
export function indexRefs(indices: unknown): FeedRef[];                               // from the /indices response
// Hook cadences unchanged as fallbacks: quote 3 s, depth 2 s, indices 5 s, watchlist 5 s.
```

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/services/browser-feed.spec.ts`, change the import line to

```typescript
import { depthFromTick, feedKey, indexRefs, isFeedSource, livePollMs, quoteForItem, quoteFromTick, tickMatches, type WireTick } from './browser-feed';
```

and append:

```typescript
const T = (over: Partial<WireTick> = {}): WireTick => ({
  token: '2885',
  symbol: 'RELIANCE',
  exchange: 'NSE',
  ltp: 1500,
  open: 1490,
  high: 1505,
  low: 1488,
  close: 1480,
  volume: 1000,
  timestamp: '2026-10-12T04:00:00.000Z',
  at: Date.parse('2026-10-12T04:00:00.000Z'),
  change: 20,
  changePercent: 1.3514,
  ...over,
});
const PREV = { ltp: 1, open: 2, high: 3, low: 0.5, close: 1.5, change: -0.5, changePct: -33, isStale: true, loading: false };

describe('quoteFromTick', () => {
  it('takes the tick’s LTP, day bar and change', () => {
    expect(quoteFromTick(PREV, T())).toEqual({ ...PREV, ltp: 1500, open: 1490, high: 1505, low: 1488, close: 1480, change: 20, changePct: 1.3514 });
  });

  it('keeps the previous field where the tick reports 0, and derives change from the close when the tick has none', () => {
    const next = quoteFromTick({ ...PREV, close: 1480 }, T({ open: 0, high: 0, low: 0, close: 0, change: undefined, changePercent: undefined }));
    expect(next).toMatchObject({ ltp: 1500, open: 2, high: 3, low: 0.5, close: 1480, change: 20 });
    expect(next.changePct).toBeCloseTo((20 / 1480) * 100, 6);
  });

  it('returns the same reference for a tick without a usable LTP', () => {
    expect(quoteFromTick(PREV, T({ ltp: 0 }))).toBe(PREV);
  });
});

describe('depthFromTick', () => {
  it('builds the MarketDepth the card renders, with totals and the tick’s receipt time', () => {
    const d = depthFromTick(T({ depth: { bids: [{ price: 1499.9, qty: 10, orders: 2 }], asks: [{ price: 1500.1, qty: 4, orders: 1 }, { price: 1500.2, qty: 6, orders: 1 }] } }));
    expect(d).toEqual({
      token: '2885',
      exchange: 'NSE',
      bids: [{ price: 1499.9, qty: 10, orders: 2 }],
      asks: [{ price: 1500.1, qty: 4, orders: 1 }, { price: 1500.2, qty: 6, orders: 1 }],
      totalBidQty: 10,
      totalAskQty: 10,
      ts: Date.parse('2026-10-12T04:00:00.000Z'),
    });
  });

  it('is undefined for a tick with no book, so the last ladder stays', () => {
    expect(depthFromTick(T())).toBeUndefined();
  });
});

describe('quoteForItem', () => {
  const item = { symbol: 'RELIANCE', token: '2885', exchange: 'NSE' };

  it('builds the store Quote under the watchlist item’s own symbol', () => {
    expect(quoteForItem(item, T({ symbol: 'RELIANCE-EQ' }))).toMatchObject({ symbol: 'RELIANCE', token: '2885', exchange: 'NSE', ltp: 1500, change: 20, changePercent: 1.3514 });
  });

  it('is null for another exchange’s same token, or a tick without a change (it would clobber the row’s change)', () => {
    expect(quoteForItem(item, T({ exchange: 'MCX' }))).toBeNull();
    expect(quoteForItem(item, T({ change: undefined }))).toBeNull();
    expect(quoteForItem(item, T({ ltp: 0 }))).toBeNull();
  });
});

describe('indexRefs', () => {
  it('reads token, exchange and symbol from the /indices rows and skips malformed ones', () => {
    expect(
      indexRefs([
        { key: 'NIFTY_50', symbol: 'NIFTY', token: '99926000', exchange: 'NSE', quote: null },
        { key: 'SENSEX', symbol: 'SENSEX', token: '99919000', exchange: 'BSE' },
        { key: 'BAD', symbol: 'X' },
      ]),
    ).toEqual([
      { token: '99926000', exchange: 'NSE', symbol: 'NIFTY' },
      { token: '99919000', exchange: 'BSE', symbol: 'SENSEX' },
    ]);
    expect(indexRefs(undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @td/web test -- browser-feed`
Expected: FAIL. `quoteFromTick`, `depthFromTick`, `quoteForItem`, `indexRefs` are not exported (`… is not a function`).

- [ ] **Step 3: Implement**

Append to `apps/web/src/services/browser-feed.ts` (and add `import type { MarketDepth } from '@td/shared';` and `import type { Quote } from '@/types';` at the top):

```typescript
/** The quote fields a screen keeps; `changePct` is the order ticket's name for changePercent. */
export interface QuoteFields {
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  change: number;
  changePct: number;
}

function positive(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Fold a tick into a screen's quote. A field the tick reports as 0 keeps the
 * previous value (the broker sends 0 for "not reported"); change comes from the
 * tick, else from the close. A tick without a usable LTP returns `prev` itself.
 */
export function quoteFromTick<T extends QuoteFields>(prev: T, tick: WireTick): T {
  if (!(typeof tick.ltp === 'number' && Number.isFinite(tick.ltp) && tick.ltp > 0)) return prev;
  const close = positive(tick.close, prev.close);
  const change = typeof tick.change === 'number' ? tick.change : close > 0 ? tick.ltp - close : prev.change;
  const changePct =
    typeof tick.changePercent === 'number'
      ? tick.changePercent
      : close > 0
        ? ((tick.ltp - close) / close) * 100
        : prev.changePct;
  return {
    ...prev,
    ltp: tick.ltp,
    open: positive(tick.open, prev.open),
    high: positive(tick.high, prev.high),
    low: positive(tick.low, prev.low),
    close,
    change,
    changePct,
  };
}

/** The depth card's MarketDepth from a tick's book; undefined when the tick carries none. */
export function depthFromTick(tick: WireTick): MarketDepth | undefined {
  const d = tick.depth;
  if (!d) return undefined;
  const sum = (levels: WireDepthLevel[]) => levels.reduce((s, l) => s + l.qty, 0);
  return {
    token: tick.token,
    exchange: tick.exchange ?? '',
    bids: d.bids,
    asks: d.asks,
    totalBidQty: sum(d.bids),
    totalAskQty: sum(d.asks),
    ts: tick.at ?? Date.parse(tick.timestamp),
  };
}

/**
 * A watchlist row's store Quote from a tick, under the ITEM's symbol (the hub's
 * symbol for the same instrument may differ). Null unless the tick is for this
 * exchange + token and carries a change: a partial tick would blank the row's %.
 */
export function quoteForItem(item: { symbol: string; token: string; exchange: string }, tick: WireTick): Quote | null {
  if (!tickMatches(tick, item.token, item.exchange)) return null;
  if (!(tick.ltp > 0) || typeof tick.change !== 'number') return null;
  return {
    symbol: item.symbol,
    token: item.token,
    exchange: item.exchange,
    ltp: tick.ltp,
    open: tick.open,
    high: tick.high,
    low: tick.low,
    close: tick.close,
    volume: tick.volume,
    change: tick.change,
    changePercent: tick.changePercent ?? 0,
    timestamp: new Date(tick.timestamp),
  } as unknown as Quote;
}

/** The index tiles' refs from the `/indices` response rows. */
export function indexRefs(indices: unknown): FeedRef[] {
  if (!Array.isArray(indices)) return [];
  const out: FeedRef[] = [];
  for (const row of indices as Array<{ token?: unknown; exchange?: unknown; symbol?: unknown } | null>) {
    if (!row || typeof row.token !== 'string' || typeof row.exchange !== 'string') continue;
    out.push({ token: row.token, exchange: row.exchange, ...(typeof row.symbol === 'string' ? { symbol: row.symbol } : {}) });
  }
  return out;
}
```

Replace `apps/web/src/hooks/useInstrumentQuote.ts` with:

```typescript
import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api';
import { wsService } from '@/services/websocket';
import { quoteFromTick, tickMatches } from '@/services/browser-feed';
import { useLivePollMs } from './useLivePollMs';

interface QuoteState {
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  change: number;
  changePct: number;
  isStale: boolean;
  loading: boolean;
}

export interface InstrumentQuote extends QuoteState {
  /**
   * Imperative re-fetch. Additive to the frozen return contract (the wiring
   * agent destructures the named data fields above and is unaffected); exposed
   * so the hook can be unit-tested via the renderToStaticMarkup + invoke-fetch
   * technique the sibling hooks (useZones / useSrEvidence) use.
   */
  refetch: () => void;
}

/** Fallback cadence: used only while the feed is not hub-served and Live. */
const POLL_INTERVAL_MS = 3_000;

const DEFAULT_QUOTE: QuoteState = {
  ltp: 0,
  open: 0,
  high: 0,
  low: 0,
  close: 0,
  change: 0,
  changePct: 0,
  isStale: false,
  loading: false,
};

/**
 * The order ticket header's single-symbol quote. One fetch of
 * `GET /market-data/instruments/:token/quote` on open, then live ticks for
 * (token, exchange) over /ws (subscribed as a viewed chart). The 3 s poll runs
 * only as the fallback: off while the hub feeds this browser and the feed is
 * Live (SP1 M4), on otherwise.
 *
 * The backend wraps the payload as `{ token, quote: { ltp, open, high, low,
 * close, change, changePercent } }` — we unwrap `data.quote` and map
 * `changePercent` -> `changePct`. On error / `ltp <= 0` we mark the quote stale
 * (so the header can render "—") rather than throwing.
 */
export function useInstrumentQuote(
  token: string | null,
  exchange: string | null,
): InstrumentQuote {
  const [quote, setQuote] = useState<QuoteState>(DEFAULT_QUOTE);
  const abortRef = useRef<AbortController | null>(null);
  const pollMs = useLivePollMs(POLL_INTERVAL_MS);

  const fetchQuote = useCallback(async () => {
    // Bail early when we don't have both inputs — nothing to fetch.
    if (!token || !exchange) {
      setQuote(DEFAULT_QUOTE);
      return;
    }

    // Cancel any in-flight request before starting a new one.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setQuote((prev) => ({ ...prev, loading: true }));
    try {
      const response = await api.get(
        `/market-data/instruments/${token}/quote`,
        { signal: controller.signal },
      );
      // A newer fetch superseded this one — don't write stale data.
      if (abortRef.current !== controller) return;

      const q = response.data?.quote ?? {};
      const ltp = Number(q.ltp) || 0;
      setQuote({
        ltp,
        open: Number(q.open) || 0,
        high: Number(q.high) || 0,
        low: Number(q.low) || 0,
        close: Number(q.close) || 0,
        change: Number(q.change) || 0,
        changePct: Number(q.changePercent) || 0,
        // No live price means the header should fall back to "—".
        isStale: ltp <= 0,
        loading: false,
      });
    } catch (err) {
      // Aborted requests are expected on rapid token changes — ignore them.
      const name = (err as { name?: string })?.name;
      const code = (err as { code?: string })?.code;
      if (name === 'CanceledError' || name === 'AbortError' || code === 'ERR_CANCELED') {
        return;
      }
      if (abortRef.current !== controller) return;
      // Fetch failed — mark stale so the header shows "—"; never crash.
      setQuote((prev) => ({ ...prev, isStale: true, loading: false }));
    }
  }, [token, exchange]);

  // Open: one fetch, the live subscription, and tick updates for this instrument.
  useEffect(() => {
    // Reset immediately when inputs clear so the header doesn't show a stale
    // price for the previous symbol during the next fetch.
    if (!token || !exchange) {
      setQuote(DEFAULT_QUOTE);
      return;
    }

    fetchQuote();
    const ref = { token, exchange };
    wsService.emitSubscribe([ref], 'chart');
    const unsubTick = wsService.subscribe('tick', (data) => {
      if (!tickMatches(data, token, exchange)) return;
      setQuote((prev) => {
        const next = quoteFromTick(prev, data);
        return next === prev ? prev : { ...next, isStale: false, loading: false };
      });
    });

    return () => {
      unsubTick();
      wsService.emitUnsubscribe([ref]);
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [fetchQuote, token, exchange]);

  // Fallback poll: off while the feed is hub-served and Live.
  useEffect(() => {
    if (!token || !exchange || pollMs === false) return;
    const intervalId = window.setInterval(fetchQuote, pollMs);
    return () => window.clearInterval(intervalId);
  }, [fetchQuote, token, exchange, pollMs]);

  return { ...quote, refetch: fetchQuote };
}
```

Replace `apps/web/src/hooks/useMarketDepth.ts` with:

```typescript
import { useCallback, useEffect, useRef, useState } from 'react';
import api from '@/services/api';
import { wsService } from '@/services/websocket';
import { depthFromTick, tickMatches } from '@/services/browser-feed';
import type { MarketDepth } from '@td/shared';
import { useLivePollMs } from './useLivePollMs';

interface UseMarketDepthResult {
  depth: MarketDepth | null;
  loading: boolean;
}

/** Fallback cadence: used only while the feed is not hub-served and Live. */
const DEPTH_POLL_MS = 2_000;

/**
 * Five-level depth for one instrument. One fetch of
 * /market-data/instruments/:token/depth on open, then the book carried on each
 * live tick (SNAP_QUOTE best-five). The 2 s poll runs only as the fallback: off
 * while the hub feeds this browser and the feed is Live (SP1 M4).
 *
 * Returns `depth: null` when the endpoint reports no depth available
 * (market closed, token not subscribable, etc.) — caller renders a
 * "Depth unavailable" caption in that case.
 */
export function useMarketDepth(token: string, exchange: string): UseMarketDepthResult {
  const [depth, setDepth] = useState<MarketDepth | null>(null);
  const [loading, setLoading] = useState(false);
  const cancelRef = useRef(false);
  const pollMs = useLivePollMs(DEPTH_POLL_MS);
  const valid = Boolean(token && token !== '0' && exchange);

  const fetchDepth = useCallback(async () => {
    try {
      const r = await api.get<{ depth: MarketDepth | null }>(
        `/market-data/instruments/${token}/depth`,
        { params: { exchange } },
      );
      if (!cancelRef.current) setDepth(r.data?.depth ?? null);
    } catch {
      if (!cancelRef.current) setDepth(null);
    } finally {
      if (!cancelRef.current) setLoading(false);
    }
  }, [token, exchange]);

  useEffect(() => {
    if (!valid) {
      setDepth(null);
      setLoading(false);
      return;
    }
    cancelRef.current = false;
    // Reset between symbol switches so we don't show the previous instrument's
    // ladder while the first fetch for the new one is in flight.
    setDepth(null);
    setLoading(true);
    void fetchDepth();

    const ref = { token, exchange };
    wsService.emitSubscribe([ref], 'chart');
    const unsubTick = wsService.subscribe('tick', (data) => {
      if (cancelRef.current || !tickMatches(data, token, exchange)) return;
      const next = depthFromTick(data);
      if (!next) return; // a tick without a book keeps the last ladder
      setDepth(next);
      setLoading(false);
    });

    return () => {
      cancelRef.current = true;
      unsubTick();
      wsService.emitUnsubscribe([ref]);
    };
  }, [valid, token, exchange, fetchDepth]);

  // Fallback poll: off while the feed is hub-served and Live.
  useEffect(() => {
    if (!valid || pollMs === false) return;
    const id = setInterval(() => void fetchDepth(), pollMs);
    return () => clearInterval(id);
  }, [valid, fetchDepth, pollMs]);

  return { depth, loading };
}
```

Replace `apps/web/src/hooks/useMarketData.ts` with:

```typescript
import { useCallback, useEffect, useRef } from 'react';
import { wsService } from '@/services/websocket';
import api from '@/services/api';
import { useMarketStore } from '@/stores/market-store';
import { type Quote } from '@/types';
import type { FeedHealth } from '@/services/feed-health';
import { marketPhase } from '@/services/refresh-policy';
import { indexRefs, isFeedSource, type FeedRef } from '@/services/browser-feed';
import { useLivePollMs } from './useLivePollMs';

/** Fallback cadence for the index snapshot: used only while the feed is not hub-served and Live. */
const INDICES_POLL_MS = 5_000;

export function useMarketData(): void {
  const updateQuote = useMarketStore((s) => s.updateQuote);
  const setConnected = useMarketStore((s) => s.setConnected);
  const setFeedHealth = useMarketStore((s) => s.setFeedHealth);
  const setFeedSource = useMarketStore((s) => s.setFeedSource);
  const setMarketStatus = useMarketStore((s) => s.setMarketStatus);
  const pollMs = useLivePollMs(INDICES_POLL_MS);
  const mountedRef = useRef(false);
  /** The index tiles, subscribed once as market context (hub priority 2). */
  const indexRefsRef = useRef<FeedRef[] | null>(null);

  // Compute market status on mount and refresh every 30 seconds
  useEffect(() => {
    setMarketStatus(marketPhase());
    const id = setInterval(() => setMarketStatus(marketPhase()), 30_000);
    return () => clearInterval(id);
  }, [setMarketStatus]);

  // The index snapshot. Its first answer also tells us which tiles to stream.
  // REAL data only, never demo numbers.
  const fetchIndices = useCallback(async () => {
    try {
      const res = await api.get('/market-data/indices');
      if (!mountedRef.current) return;
      const indices = res.data?.indices ?? [];
      for (const idx of indices) {
        if (idx.quote && idx.quote.ltp) {
          updateQuote(idx.quote as Quote);
        }
      }
      if (!indexRefsRef.current) {
        const refs = indexRefs(indices);
        if (refs.length > 0) {
          indexRefsRef.current = refs;
          wsService.emitSubscribe(refs, 'context');
        }
      }
    } catch {
      // API unreachable — leave quotes as-is; no demo fallback.
    }
  }, [updateQuote]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchIndices();
    return () => {
      mountedRef.current = false;
      if (indexRefsRef.current) {
        wsService.emitUnsubscribe(indexRefsRef.current);
        indexRefsRef.current = null;
      }
    };
  }, [fetchIndices]);

  // The topology-independent floor when ticks are not arriving (socket down,
  // a legacy feed, or a stall): off while the feed is hub-served and Live.
  useEffect(() => {
    if (pollMs === false) return;
    const id = setInterval(() => void fetchIndices(), pollMs);
    return () => clearInterval(id);
  }, [fetchIndices, pollMs]);

  // WebSocket for live tick updates
  useEffect(() => {
    wsService.connect();
    setFeedSource(wsService.getFeedSource());

    const unsubTick = wsService.subscribe('tick', (data) => {
      // Only a payload that is a full quote — a numeric `change` plus a
      // non-empty `symbol` — may enter the store. Hub ticks carry both when the
      // broker reported the previous close (SP1 M4); a raw per-user TickData
      // (no change, `symbol` may be blank in SNAP_QUOTE) would clobber the
      // REST-fetched quote with a partial one, so it is ignored here.
      const q = data as Quote;
      if (!q?.symbol || typeof q.change !== 'number') return;
      updateQuote(q);
    });

    const unsubConn = wsService.subscribe('connection-status', (data) => {
      const { connected } = data as { connected: boolean };
      setConnected(connected);
    });

    const unsubHealth = wsService.subscribe('feed-health', (data) => {
      const { health } = data as { health: FeedHealth };
      setFeedHealth(health);
    });

    // Which path feeds this browser: 'hub' lets every screen stop polling while Live.
    const unsubSource = wsService.subscribe('feed-source', (data) => {
      const source = (data as { source?: unknown } | null)?.source;
      setFeedSource(isFeedSource(source) ? source : null);
    });

    return () => {
      unsubTick();
      unsubConn();
      unsubHealth();
      unsubSource();
    };
  }, [updateQuote, setConnected, setFeedHealth, setFeedSource]);
}
```

Replace `apps/web/src/hooks/useWatchlistQuotes.ts` with:

```typescript
import { useCallback, useEffect } from 'react';
import api from '@/services/api';
import { wsService } from '@/services/websocket';
import { quoteForItem } from '@/services/browser-feed';
import { useMarketStore } from '@/stores/market-store';
import type { Quote } from '@/types';
import type { WatchlistItem } from '@/stores/watchlist-store';
import { useLivePollMs } from './useLivePollMs';

interface QuoteRow {
  token: string;
  exchange: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  change: number;
  changePercent: number;
}

/** Fallback cadence: used only while the feed is not hub-served and Live. */
const POLL_MS = 5_000;

/**
 * Keep the watchlist rows current. The rows stream over /ws as `watchlist`
 * (hub priority 3) and each matching tick updates the shared quote store under
 * the row's own symbol. One batched POST /market-data/quotes on change, and as
 * the fallback poll — off while the hub feeds this browser and the feed is Live
 * (SP1 M4).
 */
export function useWatchlistQuotes(items: WatchlistItem[]): void {
  const updateQuote = useMarketStore((s) => s.updateQuote);
  const pollMs = useLivePollMs(POLL_MS);

  const fetchOnce = useCallback(
    async (isCancelled: () => boolean) => {
      try {
        const res = await api.post('/market-data/quotes', {
          items: items.map((i) => ({ token: i.token, exchange: i.exchange })),
        });
        const list: QuoteRow[] = res.data?.quotes ?? [];
        if (isCancelled()) return;
        const byKey = new Map(list.map((q) => [`${q.exchange.toUpperCase()}:${q.token}`, q]));
        for (const it of items) {
          const q = byKey.get(`${it.exchange.toUpperCase()}:${it.token}`);
          if (!q || q.ltp == null) continue;
          updateQuote({
            symbol: it.symbol,
            token: it.token,
            exchange: it.exchange,
            ltp: q.ltp,
            open: q.open,
            high: q.high,
            low: q.low,
            close: q.close,
            change: q.change,
            changePercent: q.changePercent,
            volume: q.volume,
            timestamp: new Date(),
          } as Quote);
        }
      } catch {
        // Silent — rows keep their last value until a poll succeeds.
      }
    },
    [items, updateQuote],
  );

  // Live rows + one snapshot whenever the list changes.
  useEffect(() => {
    if (items.length === 0) return;
    let cancelled = false;
    const refs = items.map((i) => ({ token: i.token, exchange: i.exchange, symbol: i.symbol }));
    wsService.emitSubscribe(refs, 'watchlist');
    const unsubTick = wsService.subscribe('tick', (data) => {
      for (const it of items) {
        const q = quoteForItem(it, data as Parameters<typeof quoteForItem>[1]);
        if (q) updateQuote(q);
      }
    });
    void fetchOnce(() => cancelled);
    return () => {
      cancelled = true;
      unsubTick();
      wsService.emitUnsubscribe(refs);
    };
  }, [items, updateQuote, fetchOnce]);

  // Fallback poll: off while the feed is hub-served and Live.
  useEffect(() => {
    if (items.length === 0 || pollMs === false) return;
    let cancelled = false;
    const id = setInterval(() => void fetchOnce(() => cancelled), pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [items, fetchOnce, pollMs]);
}
```

The watchlist snapshot now matches rows by EXCHANGE:token instead of token alone (the old `byToken` map), so a token held on two exchanges no longer cross-fills.

- [ ] **Step 4: Run tests and the web typecheck**

Run: `pnpm --filter @td/web test -- browser-feed useInstrumentQuote websocket`
Expected: PASS. `useInstrumentQuote.spec` still captures `refetch` through `renderToStaticMarkup`; effects do not run there, so no socket is touched.
Run: `pnpm --filter @td/web exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/services/browser-feed.ts apps/web/src/services/browser-feed.spec.ts apps/web/src/hooks/useInstrumentQuote.ts apps/web/src/hooks/useMarketDepth.ts apps/web/src/hooks/useMarketData.ts apps/web/src/hooks/useWatchlistQuotes.ts
git commit -m "feat(web): quote, depth, indices and watchlist live on ticks; polls only when the feed is not hub-served and Live" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/web/src/services/browser-feed.ts apps/web/src/services/browser-feed.spec.ts apps/web/src/hooks/useInstrumentQuote.ts apps/web/src/hooks/useMarketDepth.ts apps/web/src/hooks/useMarketData.ts apps/web/src/hooks/useWatchlistQuotes.ts
```

---

### Task 9: The chart's live edge from ticks (spec §6.3)

**Files:**
- Modify: `apps/web/src/utils/chartSeries.ts`
- Modify: `apps/web/src/utils/chartSeries.spec.ts`
- Modify: `apps/web/src/hooks/useLiveRefresh.ts`
- Modify: `apps/web/src/hooks/useChartData.ts`

**Interfaces:**
- Consumes: `applyTick`, `ChartSeries` (`chartSeries.ts`); `useLivePollMs`, `tickMatches`, `WireTick` (Task 7).
- Produces:

```typescript
// utils/chartSeries.ts
export function tickOpensGap(series: ChartSeries, tickTimeSec: number): boolean;   // true when applyTick would refuse for a gap
// hooks/useLiveRefresh.ts
export function useLiveRefresh(fn: () => void | Promise<void>, baseMs: number, opts?: { paused?: boolean }): void
// hooks/useChartData.ts: the 20 s live-edge poll is paused while hub-served and Live; a tick that
// opens a gap triggers one live-edge refresh (at most every GAP_FILL_COOLDOWN_MS = 15 s).
```

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/utils/chartSeries.spec.ts`, add `tickOpensGap,` to the import list from `./chartSeries`, and append:

```typescript
describe('tickOpensGap', () => {
  const base = () => buildSeries([real(1000), real(1060)], TF);

  it('is true only for a tick two or more bars past the last bar', () => {
    expect(tickOpensGap(base(), 1075)).toBe(false); // the forming bar
    expect(tickOpensGap(base(), 1125)).toBe(false); // the next bar: applyTick opens it
    expect(tickOpensGap(base(), 1180)).toBe(true); // two bars past: applyTick refuses, REST must fill
    expect(tickOpensGap(base(), 1000)).toBe(false); // a late tick
  });

  it('is false for an empty series (cold start belongs to the initial load) and a non-finite time', () => {
    expect(tickOpensGap(emptySeries(TF), 5000)).toBe(false);
    expect(tickOpensGap(base(), Number.NaN)).toBe(false);
  });

  it('agrees with applyTick: whenever it is true, applyTick leaves the series unchanged', () => {
    const s = base();
    for (const t of [1075, 1125, 1180, 1300]) {
      if (tickOpensGap(s, t)) expect(applyTick(s, { time: t, price: 9 })).toBe(s);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @td/web test -- chartSeries`
Expected: FAIL with `tickOpensGap is not a function`.

- [ ] **Step 3: Implement**

In `apps/web/src/utils/chartSeries.ts`, directly after `applyTick`, add:

```typescript
/**
 * True when a tick lands two or more bars past the last bar — the case
 * `applyTick` refuses (a session boundary, or bars missed while away), because
 * only the broker's REST bars carry authoritative timestamps. With the live edge
 * driven by ticks (SP1 M4), this is the one moment the chart must ask REST.
 */
export function tickOpensGap(series: ChartSeries, tickTimeSec: number): boolean {
  const last = series.bars[series.bars.length - 1];
  if (!last || !Number.isFinite(tickTimeSec)) return false;
  return tickTimeSec - last.realTime >= series.tfSec * 2;
}
```

In `apps/web/src/hooks/useLiveRefresh.ts`:
- change the signature to

```typescript
export function useLiveRefresh(
  fn: () => void | Promise<void>,
  baseMs: number,
  opts: { paused?: boolean } = {},
): void {
  const paused = opts.paused === true;
```

- replace the single `schedule();` call with:

```typescript
    // Paused: no timer (live ticks drive the data); the tab/network catch-up
    // below still runs, so a returning tab refreshes once.
    if (!paused) schedule();
```

- change the effect's dependency list from `[baseMs]` to `[baseMs, paused]`;
- add to the doc comment: `` `opts.paused` stops the interval but keeps the return catch-up (SP1 M4: the chart's live edge comes from ticks while the feed is hub-served and Live). ``

In `apps/web/src/hooks/useChartData.ts`:
- change the `chartSeries` import to include `tickOpensGap`, and the `browser-feed` import (Task 7) to `import { feedKey, tickMatches, type FeedRef, type WireTick } from '@/services/browser-feed';`; add `import { useLivePollMs } from './useLivePollMs';`;
- delete the local `TickData` interface together with its doc comment (`The per-user tick payload emitted on the 'tick' socket event …`); `WireTick` replaces it;
- after `getHistoryRangeDays`, add:

```typescript
/** The live-edge REST cadence when ticks are not driving the chart (legacy feed, or not Live). */
const LIVE_EDGE_POLL_MS = 20_000;
/** At most one gap-triggered live-edge refresh per this window. */
const GAP_FILL_COOLDOWN_MS = 15_000;
```

- directly after `const { series, prependSeq } = state;`, add:

```typescript
  // Latest series for the tick handler, which subscribes once per symbol, not per render.
  const seriesRef = useRef(series);
  seriesRef.current = series;
  // false while the hub feeds this browser and the feed is Live: ticks drive the live edge then.
  const livePoll = useLivePollMs(LIVE_EDGE_POLL_MS);
  const livePollRef = useRef(livePoll);
  livePollRef.current = livePoll;
  const lastGapFillRef = useRef(0);
```

- replace `useLiveRefresh(liveEdgeRefresh, 20_000);` with:

```typescript
  // SP1 M4 (spec §6.3): while the hub feeds this browser and the feed is Live,
  // ticks advance the live edge and this poll is paused; a tick that opens a gap
  // asks for one refresh instead (see the tick handler). Otherwise: today's 20 s.
  useLiveRefresh(liveEdgeRefresh, LIVE_EDGE_POLL_MS, { paused: livePoll === false });
```

- replace the whole "Live ticks" effect (from `useEffect(() => {` with `const unsubTick = wsService.subscribe('tick', …` through its `}, [selectedSymbol.token, timeframe]);`) with:

```typescript
  useEffect(() => {
    const unsubTick = wsService.subscribe('tick', (data) => {
      if (!tickMatches(data, selectedSymbol.token, selectedSymbol.exchange)) return;
      const tick: WireTick = data;
      if (!(typeof tick.ltp === 'number' && tick.ltp > 0)) return;
      const time = new Date(tick.timestamp).getTime() / 1000;
      setCurrentPrice(tick.ltp);
      // Hub ticks carry the change vs the previous close; legacy ticks do not.
      if (typeof tick.change === 'number' && typeof tick.changePercent === 'number') {
        setPriceChange(tick.change);
        setPriceChangePercent(tick.changePercent);
      }
      dispatch({
        type: 'tick',
        epoch: epochRef.current,
        tick: { time, price: tick.ltp, volume: tick.volume },
      });
      // Ticks drive the live edge (poll paused): a tick past a gap means bars the
      // broker must supply — the first bar of a session, or bars missed while away.
      if (
        livePollRef.current === false &&
        tickOpensGap(seriesRef.current, time) &&
        Date.now() - lastGapFillRef.current >= GAP_FILL_COOLDOWN_MS
      ) {
        lastGapFillRef.current = Date.now();
        void liveEdgeRefresh();
      }
    });

    // Server-side closed-candle events (CandleAggregator). Same merge path as
    // the REST poll — the broker timestamp is authoritative either way.
    // NOTE: currently UNFED — nothing calls the gateway's emitCandleToUser in
    // the per-user feed. Kept (harmless) for when that emitter is wired.
    const unsubCandle = wsService.subscribe('candle', (data) => {
      const candle = data as {
        token: string;
        timeframe: string;
        timestamp: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
      };
      if (candle.token !== selectedSymbol.token) return;
      if (candle.timeframe !== timeframe) return;
      dispatch({
        type: 'rest',
        epoch: epochRef.current,
        bars: [
          {
            time: new Date(candle.timestamp).getTime() / 1000,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
          },
        ],
      });
    });

    return () => {
      unsubTick();
      unsubCandle();
    };
  }, [selectedSymbol.token, selectedSymbol.exchange, timeframe, liveEdgeRefresh]);
```

- in the "Series state" block comment, change `(initial fetch, WS tick, 20s REST poll, …)` to `(initial fetch, WS tick, 20s REST poll or gap-triggered refresh, …)`.

- [ ] **Step 4: Run tests, the web typecheck and lint**

Run: `pnpm --filter @td/web test -- chartSeries useChartData`
Expected: PASS (`useChartData.reducer.spec`, `useChartData.windowDays.spec`, `useChartData.subscribe.spec` included).
Run: `pnpm --filter @td/web exec tsc --noEmit -p tsconfig.json` and `pnpm --filter @td/web lint`
Expected: no type errors, and no lint finding in a line this plan touched (if `main` already has findings, run `pnpm --filter @td/web exec eslint src/hooks src/services src/utils/chartSeries.ts src/stores/market-store.ts` on both and compare).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/utils/chartSeries.ts apps/web/src/utils/chartSeries.spec.ts apps/web/src/hooks/useLiveRefresh.ts apps/web/src/hooks/useChartData.ts
git commit -m "feat(web): the chart's live edge comes from ticks while hub-served and Live; a gap asks REST once" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/web/src/utils/chartSeries.ts apps/web/src/utils/chartSeries.spec.ts apps/web/src/hooks/useLiveRefresh.ts apps/web/src/hooks/useChartData.ts
```

---

### Task 10: Verification and production gate

**Files:**
- Modify: `docs/superpowers/plans/2026-10-10-sp1-m4-browser-feed.md` (record results in the ledger section at the end)

- [ ] **Step 1: Whole API suite**

Run: `pnpm --filter @td/api test 2>&1 | tail -15`
Expected: every suite passes. Record the totals below. The M3 ledger had 241 suites / 2992 tests; later merges may have added more. M4 adds 3 API suites (`depth-levels.spec`, `browser-feed.spec`, `serve-browser.spec`); every other new test extends an existing file.

- [ ] **Step 2: Whole web suite**

Run: `pnpm --filter @td/web test 2>&1 | tail -15`
Expected: every file passes. M4 adds 2 web spec files (`browser-feed.spec`, `websocket.subscribe.spec`). Record the totals.

- [ ] **Step 3: The architecture ratchet is unchanged**

Run: `pnpm --filter @td/api test -- only-door.spec` and `git diff main -- apps/api/src/modules/market-hub/only-door.spec.ts`
Expected: PASS and an empty diff (`KNOWN_VIOLATORS` did not grow).

- [ ] **Step 4: Typecheck the files this plan touched**

Run: `pnpm --filter @td/api exec tsc --noEmit -p tsconfig.json 2>&1 | grep -E "market-hub|market-data|broker-adapter|tick-source.adapter.spec|configuration" || echo "no errors in M4 API files"`
Expected: `no errors in M4 API files`, or only errors on lines unchanged since the merge base (check with `git blame`, as the M2 and M3 ledgers did). `browser-feed.ts` and `serve-browser.ts` will show the same environmental TS2307 on `@td/shared/types` as `angel-one-adapter.service.ts`; record it.
Run: `pnpm --filter @td/web exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Record and commit**

Fill in the ledger table below (date, totals, typecheck results), then:

```bash
git commit -m "docs(plans): SP1 M4 verification results" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- docs/superpowers/plans/2026-10-10-sp1-m4-browser-feed.md
```

---

## M4 production gate (after deploy, owner-run)

No migration in M4. After the deploy (API and web together), keep `MARKET_HUB_ENABLED=true` and
`HUB_OWNER_USER_ID=<your users.id>` (already set if the M3 gate ran), then set `HUB_SERVES_BROWSER=true`.
Hard-reload the browser so it runs the M4 bundle. Over **one full NSE session (09:15–15:30 IST)**, keep
the market overview open, and for at least an hour also a chart (one NSE equity and one NFO option in
turn) with the order ticket, the depth card and the watchlist panel visible.

**Browser (devtools, your account):**
- The `/ws` socket receives `feed-source` `{ source: 'hub' }` on connect (Network → WS → Messages).
- The header badge reads **Live** at every look from 09:15 to 15:30.
- Network tab, filtered to `market-data`, for 10 minutes with every screen above open: after the first
  load, **no** periodic `GET …/quote`, `GET …/depth`, `GET /indices`, `POST /quotes` or `GET …/candles`.
  A single `/candles` call after a gap (session open, tab return) is expected.
- The depth card's ladder moves with the ticks; the order ticket's LTP and change move with the chart.
- Switching the chart to an NFO option shows that option's own prices (not an NSE cash instrument with
  the same token).

**`/healthz/detail` → `hub.value`:**
- `consumers.flags.browser` = `true`. If `consumers.browser.hub` is flat, check this first.
- `consumers.browser.hub` rises on each page load; `consumers.browser.legacy` rises only on first loads
  of instruments the hub had not priced yet (a never-priced first call is legitimate).
- `slots.criticalOverflow` = 0 and `prices.oldestP0AgeMs` < 5000 (M3's bound still holds with browser
  watches at priorities 2–4 alongside the positions).
- `governor.endpoints.quote.throttlesLastHour` ≈ 0.

**Database (the browser's own stall reports, `POST /healthz/client-report`):**

```sql
SELECT "createdAt", health, "secondsSinceLastTick", "recoveredWithoutReload"
FROM client_feed_reports
WHERE "userId" = '<your users.id>' AND "createdAt" >= date_trunc('day', now()) + interval '3 hours 45 minutes'
                                   AND "createdAt" <  date_trunc('day', now()) + interval '10 hours'
ORDER BY "createdAt";
-- want: no rows (09:15–15:30 IST = 03:45–10:00 UTC), other than around a deploy restart
```

**Logs:**
- No `subscribe failed for user <your id>` line (your subscriptions no longer reach the manager).
- No `sent N token(s) without an exchange` line after the first hard reload (an old bundle).

**Another account, if one exists:** its socket receives `feed-source` `{ source: 'legacy' }`, and its
screens keep polling exactly as before.

**Revert path:** `HUB_SERVES_BROWSER=false` puts your browser back on the legacy path (socket and REST)
without a deploy; the browser resumes its polls on reconnect because the server then says `legacy`.
Not behind the switch (only a code revert undoes them):
- Task 2: ticks and FULL quotes carry `depth` (for every user; the legacy tick payload grows by the
  book), and hub prices carry `day`/`depth`.
- Task 4: the gateway subscribes on the client's exchange (bare tokens = NSE), and coalesces legacy ticks
  per `EXCHANGE:token`.
- Tasks 7–9: the web client sends refs with exchange and purpose, ref-counts subscriptions, matches ticks
  by exchange, and its quote, depth, watchlist and order-ticket screens subscribe to the feed (for legacy
  users too; their polls continue).

M4 is complete when this gate is observed in production, not when the tests pass (parent spec rule).

## Notes for later milestones (not in this plan)

- **Multi-tenant:** `hubFor(userId, 'browser')` returns that user's own hub; the gateway already keeps
  one listener and one watch set per user/socket, and the REST tiers already ask per request. Nothing
  else changes. The `rest:*` watch owners are per hub, so they stay correct.
- **`ManualTradePage`** still polls `/quote` once per held position every 5 s and `/trades/open` every
  5 s. With the hub on, those `/quote` calls are answered from the PriceBook (no broker call), and the
  owner's P0 position ticks already reach its tick overlay. Gate its quote poll with `useLivePollMs`
  once the gate confirms the overlay matches by symbol, or move it to `quoteForItem` (by exchange +
  token).
- **Other polls left as they are:** chart-context 60 s (M6, CandleStore-backed), commodities 10 s,
  breadth and sector heatmap 30 s, stock monitors 10 s, the option chain 10 s (M5).
- **`POST /instruments/:token/watch`** (`MarketFeedService.addViewing`, the dead shared stack) is still
  called by the chart; it is deleted with the shared stack in M6.
- **Gateway `emitCandleToUser`** is still unfed. The CandleStore's closed 1m bars could be pushed per
  viewed chart; not needed while ticks drive the live edge.
- **Bandwidth:** the owner's room receives every hub price (decision 8). If a large watch set ever makes
  this noticeable, filter the push to the socket's own watches plus P0–P2.
- **Old bundles:** drop the bare-token NSE fallback (`parseFeedRefs`) one release after M4 ships.

## Verification ledger

| Date | Whole suite (API / web) | Typecheck (M4 files) | Notes |
|---|---|---|---|
| 2026-10-09 (branch `feature/sp1-m4-browser-feed` @ 25e5ab2, base 9156092) | API: `Test Suites: 245 passed, 245 total` / `Tests: 3081 passed, 3081 total` (0 failed; includes the 3 new suites `depth-levels.spec`, `browser-feed.spec`, `serve-browser.spec`; Jest printed the usual "worker process has failed to exit gracefully" teardown warning, exit 0). Web: `Test Files 64 passed (64)` / `Tests 591 passed (591)` (0 failed; includes `browser-feed.spec` 20 tests and `websocket.subscribe.spec` 8 tests; vitest exited 1 only on the environmental ENOTDIR results-cache write into the `apps/web/node_modules` junction). Ratchet: `only-door.spec` 1 suite / 2 tests passed; `git diff 9156092 -- apps/api/src/modules/market-hub/only-door.spec.ts` empty (`KNOWN_VIOLATORS` did not grow). | API (filtered to market-hub / market-data / broker-adapter / tick-source.adapter.spec / configuration): only environmental errors. TS2307 on `@td/shared/*` (incl. the new `browser-feed.ts` and `serve-browser.ts`, same as `angel-one-adapter.service.ts`), plus TS18046/TS2698/TS2339 knock-ons of the unresolved shared constants and one TS2339 at `market-data.controller.ts:984` (`updateInstrumentTokenFrom`); `git blame 9156092..HEAD` shows every non-TS2307 error line unchanged since the base (`^9156092`). Web: `tsc --noEmit` clean (exit 0, no output). | Fix-wave deviations from the plan text, all covered by the suites above: **R6** (8e7f020) the REST tiers answer from the hub only when its price is fresh; a stale price or a closed market takes the legacy path; **R7** (b85eee0) on the web client a more urgent subscriber raises a held feed ref's purpose (re-sends subscribe) instead of being ignored; **R8** (39daa8c) the legacy `/ws` path holds each socket's refs (capped at 100) and forwards only new subscribes / held unsubscribes to `UserFeedManager`, so a purpose raise no longer leaks a broker subscription; **M3** (25e5ab2) a closed tab unsubscribes only its own legacy refs, and `releaseUser` runs only on the user's last socket; **I1** (e65cb38) only ticks matching an index ref by exchange + token enter the web's symbol-keyed market store (the owner's room receives every hub price); `/ws` disconnect also resets the feed-source. Production gate above is still owner-run and outstanding. |
