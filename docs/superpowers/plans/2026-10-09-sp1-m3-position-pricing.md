# SP1 · M3 — Position Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ] `) syntax for tracking.

**Scope:** migration step **M3 only** of the SP1 spec. The trade-tracker, the sentinel's tick source and
`ExitPriceService` (and through it every strategy-track exit, breakout-swing and every end-of-day
square-off) read prices from the hub through `hub.price()`. M4–M6 get their own plans. Out of scope:
the gated watch-monitor WebSocket path (M4 `ticks$`), stock-monitor (M4/M6), the paper-trade service
and `open-paper-trade-refresher` (paper engine), setup-tracker (M6), moving these gates onto the
SessionClock (parent B2), and any change to the instrument-master cron.

**Goal:** Every open position is priced by the hub, at most 5 s old, for the whole session, with zero
unpriced positions, and every strategy-track exit decision uses a hub price no older than 10 s. The
dead shared-feed `AngelOneAdapterService.getLtpsBatch/getLiveQuote` calls in the EOD square-offs and
breakout-swing go through `ExitPriceService`. Each consumer reverts to its legacy path by flipping one
flag, with no deploy.

**Architecture:** One seam, `HubPriceSource.hubFor(userId, consumer)`, answers which hub prices this
user's instruments for this consumer. Today it returns the owner's hub when the hub runs, the
consumer's switch is on, and `userId` is the owner or `null` (the system-wide paper tracks), and
returns `null` otherwise. On `null` the consumer keeps its legacy path. Consumers in other modules
resolve the `HUB_PRICE_SOURCE` token lazily through `ModuleRef`, as `/candles` does in M2, because
MarketHubModule imports TradeTrackerModule and MarketDataModule. The hub watches each open position
at priority 0 and its underlying at priority 1, with the underlying resolved from one index map plus
the instrument master. The trade-tracker applies every hub price for the owner's positions as it
arrives, which is what makes ≤ 5 s possible. Its 12 s sweep stays as the safety net. Tracker writes
are keyed by exchange + token, never token alone.

**Tech Stack:** NestJS 11, TypeScript 5.7, Prisma 6, Jest 29 (`ts-jest`, `isolatedModules`),
`@nestjs/schedule` 5, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-05-sp1-market-data-hub-design.md` (§2 criteria, §3.1 hub API,
§5.3 PriceBook, §9 M3 row, §10, §11). Builds on the M1 plan
`docs/superpowers/plans/2026-10-05-sp1-m1-market-hub-core.md` and the M2 plan
`docs/superpowers/plans/2026-10-08-sp1-m2-candle-store.md`.

**Branch:** `feature/sp1-m3-position-pricing`, from `main`.

**Test command (all tasks):** `pnpm --filter @td/api test -- <file-pattern>`. Jest `rootDir` is
`apps/api/src`, `testRegex` is `.*\.spec\.ts$`. Example: `pnpm --filter @td/api test -- underlying.spec`.

## Decisions taken with the owner (2026-10-09)

1. **Personal MVP now, built to scale: one seam.** `hubFor(userId: string | null, …)` answers "which
   hub prices this user's or this consumer's instruments". Today it returns the owner's hub when the
   hub is running AND (`userId === HUB_OWNER_USER_ID` OR `userId === null`), and `null` otherwise.
   `null` userIds are the system-wide paper strategy tracks, which have no userId. Multi-tenant later
   means `hubFor` returns that user's own hub, with no consumer changes. User A's positions are never
   priced from user B's session.
2. **Breakout-swing and ALL end-of-day square-offs are in scope:** adaptive-stop, ungated, anand
   `expireIntradayAtClose`, sell-futures `squareOffOpenPositions` and breakout-swing. They change
   ONLY their price source, to `ExitPriceService`, and keep each site's existing fallback. The old
   silos get no new features, because SP6 retires them.

Deviations from the brief or the spec text, with reasons:

3. **`hubFor` takes the consumer kind:** `hubFor(userId, 'positions' | 'tracks')`, rather than two
   resolvers. The flag check lives in one place, so a consumer cannot get a hub while its switch is
   off. When multi-tenant arrives, only `hubFor`'s body changes.
4. **`HubPrices.watch` takes a list:** `watch(refs, priority, owner, ttlMs?)` replaces the brief's
   single `ref`, and it never rejects. `ExitPriceService` renews up to ~40 track tokens every 30 s.
   One registration followed by one reconcile replaces 40 concurrent `LiveFeed.reconcile()` calls
   racing on the same subscription diff. A broker failure lands in `status().lastError`, not in the
   caller.
5. **`HubEngine.onPrice` now also reports polled quotes.** In M1 it reported live ticks only. When
   the socket is down, positions are polled every ~2 s on the Critical lane (spec §5.1). Without this
   change those prices would reach the tracker only through the 12 s sweep, which breaks ≤ 5 s. The
   CandleBuilder still listens to `LiveFeed.onPrice` (live ticks only), as the M2 rule requires.
6. **The legacy tracker fan-out is kept.** The brief says "non-owner users: legacy path unchanged".
   A legacy (unscoped) `applyTick` still prices every holder of that instrument, as it does today. A
   hub tick is scoped to the hub's user and never touches another user's tracker. When both arrive in
   one flush, a user's own scoped price wins over the market-wide one.
7. **`MarketDataRepository.getInstrumentByToken(token, exchange?)` gains an optional exchange
   filter.** The code map confirms it has none, and tokens collide across segments. Existing callers
   are unchanged.
8. **Some sentinel tests change.** They mocked a NIFTY "cash row" with token `26000`; they now expect
   the index token `99926000`. That cash row never existed: index rows are not in `instruments`,
   which is exactly the production warning "resolved … to underlying NIFTY, but no NSE cash/index
   instrument". The stock-option path keeps its own tests, now on `KEI`.
9. **The tracker sweep keeps `openTrackerRefsByUser`.** A price lookup needs only exchange + token.
   The new `openPositionRefsByUser` (with real symbols) feeds the hub's watch set. Both share one
   database read and one cache, and the existing poller tests keep their mocks.
10. **Counters.** `hub.consumers.positions` counts the tracker sweep's outcomes and the sentinel's
    reads, for every user's trackers: a non-owner's are always `legacy`. `hub.consumers.tracks`
    counts `ExitPriceService`'s outcomes. Counts are cumulative since boot, with `lastHubAt` and
    `lastUnpricedAt` stamps. A short-lived burst (the first call on a new instrument is never priced
    yet) is told apart from a steady failure by how recent `lastUnpricedAt` is.
11. **Legacy socket tier and shared tokens.** The tracker's legacy socket tier (the dead shared
    `MarketFeedService`, keyed by token alone) is skipped for any token that open trackers hold on
    two exchanges. A legacy REST answer, also keyed by token alone, is attributed only when the user
    asked for that token on exactly one exchange.
12. **Where the code goes beyond the code map, the code wins.** `MarketHubService` already has five
    constructor parameters (`config, manager, tracker, prisma, jobs`, with `JobRunnerService` added in
    M2's fix round). This plan adds a sixth, `MarketDataRepository`. `HubEngine.onPrice` today
    forwards `LiveFeed.onPrice` only. `QuotePoller.apply` writes the book without notifying anyone,
    hence decision 5. `HubEngine.positions` becomes a map of `{ ref, priority }`.
13. **No symbol-prefix fallback for underlyings.** The brief does not ask for one. BFO contracts are
    not in the master (`DERIVATIVE_SEGMENTS` is NFO and MCX only), so a BFO option's underlying stays
    unresolved, as it is today. See Notes for later.
- **Controller ruling (plan review): track exits watch at priority 3, not 0.** Paper strategy-track entries must never take live slots from the owner's real positions (P0, never demoted); demoted to near-live polling (~5 s) they still meet the 10 s bound for decisions made every 30 s. `EXIT_WATCH_PRIORITY = 3`.

## Global Constraints

- **Flags:** `HUB_PRICES_POSITIONS` (tracker sweep + hub tick listener + sentinel tick source) and
  `HUB_PRICES_TRACKS` (`ExitPriceService`, and through it the track pollers, breakout-swing and the
  EOD square-offs). Both default **false**, and both need `MARKET_HUB_ENABLED=true` and
  `HUB_OWNER_USER_ID`. With either off, that consumer's behaviour is exactly M2's.
- **The `hubFor` rule:** the hub serves `userId === HUB_OWNER_USER_ID` or `userId === null` only.
  User A's positions are never priced from user B's session. Hub-sourced tracker ticks are scoped to
  that user (`applyTick(ref, ltp, { userId })`).
- **Freshness:** open positions ≤ **5 000 ms** (`HUB_MAX_AGE_MS` in the tracker sweep). Trading
  decisions (sentinel contract and spot, track exits) ≤ **10 000 ms** (spec §5.3).
- **Priorities:** open-position contracts **0** and their underlyings **1**, under the owner
  `hub:positions`. Track exits are watched at **3** (demotable) under `track:exit` with a **120 000 ms** TTL,
  renewed on every resolve.
- **Instrument keys:** every map, cache and tracker write is keyed by **exchange + token**
  (`EXCHANGE:token`), never by token alone.
- **Hub misses fall back:** a hub answer that is not `fresh` (stale, market-closed, never-priced,
  not-watched, throttled, no-session) falls through to that consumer's legacy tiers. A hub miss never
  becomes a price of 0.
- **Boot must not block:** nothing in `onModuleInit` awaits the network or the database. Consumers
  resolve the hub lazily, never at construction.
- **Bounded memory:** price listeners ≤ consumers (2). The tracker's hub-owned set ≤ open trackers.
  Pending ticks ≤ distinct (user scope, instrument) pairs, cleared every flush. The hub's underlying
  cache ≤ 1 000 entries (cleared when full). Consumer counters are fixed-size.
- **Only door:** `KNOWN_VIOLATORS` in `only-door.spec.ts` must not grow. No new broker market-data
  call outside `modules/market-hub/`.
- **Commits:** explicit pathspecs (`git commit -- <paths>`), never a bare `git commit` or `-a`. Every
  message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **An option position whose underlying is an index.** NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY/SENSEX
   rows are not in `instruments`, so the underlying must come from the one index map, with no cash
   lookup. (Task 2 test "resolves an index option to the index token from the one map, with no cash
   lookup"; Task 3 test "watches the owner’s positions with their real symbols, and an index option’s
   underlying at priority 1"; Task 6 test "takes an index option’s spot from the hub at priority 1".)
2. **The same token on two exchanges.** NSE cash, NFO and MCX tokens collide. A price for one must
   never be written to the other. (Task 4 tests "keeps the same token on two exchanges apart" and
   "legacy: keeps the same token on two exchanges apart"; Task 5 test "same token on two exchanges:
   the hub prices each instrument separately"; Task 8 test "keys prices by exchange + token, so a
   same-token entry on another exchange is not priced by it".)
3. **A non-owner user's position.** It must never be priced from the owner's hub, by the sweep, by
   the tick listener or by the sentinel. (Task 1 test "hubFor serves only the owner (or system-wide
   null) and only for a consumer whose flag is on"; Task 5 test "never prices a non-owner’s tracker
   from the owner’s hub"; Task 6 test "a non-owner’s position never reads the owner’s hub".)
4. **The hub cannot answer: not running, flag off, or a first call before any price arrives.** Every
   consumer must take its legacy path, and a never-priced instrument must not become "price 0".
   (Task 1 test "hubFor is null when the hub is not running, whatever the flags say"; Task 5 test
   "with no hub for the user (flag off or hub not running) the sweep is exactly the legacy path";
   Task 7 tests "a never-priced ref
   is watched at priority 0 and falls back to the legacy tiers — never a hub price of 0" and "takes
   the legacy path untouched when the tracks flag is off, the hub is absent, or the lookup throws".)
5. **The EOD square-off at 15:25 with no fresh price.** It must close at the last known price
   (`currentPrice ?? executedPrice`), never at 0 and never skip silently. (Task 8 test "EOD at 15:25
   with no fresh price closes at the last known price, not at 0"; Task 7 test "at 15:25 a hub price
   older than 10 s is not fresh; with no legacy price the answer is none".)

---

## File Structure

| Path | Responsibility |
|---|---|
| Create `market-hub/hub-prices.ts` | `HUB_PRICE_SOURCE` token, `HubConsumer`, `HubOutcome`, `HubPrices`, `HubPriceSource`, `lookupHubPrices()`, `engineHubPrices()` (type-only imports) |
| Create `market-hub/underlying.ts` | `INDEX_UNDERLYINGS` (the one index map), `isDerivative()`, `resolveUnderlying()` |
| Modify `market-hub/hub-engine.ts` | `onPrice` for ticks and polled quotes, `watchMany`, `recordConsumer`, `status().consumers`, `setPositions(refs, underlyings)` |
| Modify `market-hub/quote-poller.ts` | optional `onPrice` dep, called on every polled price |
| Modify `market-hub/market-hub.service.ts`, `market-hub.module.ts` | implements `HubPriceSource`; `hubFor`, `record`; positions with real symbols + priority-1 underlyings; `HUB_PRICE_SOURCE` provider |
| Modify `market-data/repositories/market-data.repository.ts` | `getInstrumentByToken(token, exchange?)` |
| Modify `trade-tracker/services/trade-tracker.service.ts` | `openPositionRefsByUser()`; `applyTick(target, ltp, scope?)` and `flushTicks` keyed by exchange + token + scope |
| Modify `trade-tracker/services/trade-tracker-poller.service.ts` | hub tier (≤ 5 s), hub tick listener, counters; legacy tiers keyed by exchange + token |
| Modify `trade-sentinel/adapters/tick-source.adapter.ts` | contract price + underlying spot from the hub; shared underlying helper; resolved exchange instead of the hard-coded `NSE` |
| Modify `trade-sentinel/services/context-packet.service.ts` | `SPOT_SOURCE_HUB` |
| Modify `signal-generator/services/exit-price.service.ts` | hub tier: watch at P0 with TTL, ≤ 10 s, `source: 'hub'` |
| Modify `adaptive-stop-track/services/adaptive-stop-tick-poller.service.ts`, `ungated-track/services/ungated-tick-poller.service.ts`, `anand-dual-track/services/anand-price-monitor.service.ts`, `sell-futures-track/services/sell-futures.service.ts`, `breakout-swing-track/services/breakout-swing-poller.service.ts` | EOD / breakout-swing prices through `ExitPriceService` |
| Modify `config/configuration.ts`, `deploy/env/api.env.example` | `HUB_PRICES_POSITIONS`, `HUB_PRICES_TRACKS` |

`market-hub/…`, `trade-tracker/…` etc. are under `apps/api/src/modules/`; `config/…` under `apps/api/src/`.

---

### Task 1: The seam: `hub-prices.ts`, `hubFor`, flags, counters

**Files:**
- Create: `apps/api/src/modules/market-hub/hub-prices.ts`
- Modify: `apps/api/src/modules/market-hub/hub-engine.ts`
- Modify: `apps/api/src/modules/market-hub/hub-engine.spec.ts`
- Modify: `apps/api/src/modules/market-hub/quote-poller.ts`
- Modify: `apps/api/src/modules/market-hub/quote-poller.spec.ts`
- Modify: `apps/api/src/modules/market-hub/market-hub.service.ts`
- Modify: `apps/api/src/modules/market-hub/market-hub.service.spec.ts`
- Modify: `apps/api/src/modules/market-hub/market-hub.module.ts`
- Modify: `apps/api/src/config/configuration.ts`
- Modify: `deploy/env/api.env.example`

**Interfaces:**
- Consumes: `HubEngine`, `PriceBook`, `QuotePoller`, `WatchRegistry` (M1); `InstrumentRef`, `Price`, `PriceResult`, `Priority`, `refKey` (`hub.types.ts`).
- Produces:

```typescript
// hub-prices.ts — type-only imports; safe to import from any module
export const HUB_PRICE_SOURCE = 'HUB_PRICE_SOURCE';
export type HubConsumer = 'positions' | 'tracks';
export type HubOutcome = 'hub' | 'legacy' | 'unpriced';
export interface HubPrices {
  price(ref: InstrumentRef, opts: { maxAgeMs: number }): PriceResult;
  prices(refs: readonly InstrumentRef[], opts: { maxAgeMs: number }): Map<string, PriceResult>;
  watch(refs: readonly InstrumentRef[], priority: Priority, owner: string, ttlMs?: number): Promise<void>;
  onPrice(fn: (p: Price) => void): () => void;
}
export interface HubPriceSource {
  hubFor(userId: string | null, consumer: HubConsumer): HubPrices | null;
  record(consumer: HubConsumer, outcome: HubOutcome, count?: number): void;
}
export function lookupHubPrices(moduleRef: Pick<ModuleRef, 'get'> | null | undefined): HubPriceSource | null;
export function engineHubPrices(engine: Pick<HubEngine, 'price' | 'prices' | 'watchMany' | 'onPrice'>): HubPrices;

// hub-engine.ts
export interface ConsumerCounters { hub: number; legacy: number; unpriced: number; lastHubAt: number | null; lastUnpricedAt: number | null }
HubStatus.consumers: { positions: ConsumerCounters; tracks: ConsumerCounters; listenerErrors: number }
HubEngine.onPrice(fn: (p: Price) => void): () => void          // live ticks AND polled quotes
HubEngine.watchMany(refs: readonly InstrumentRef[], priority: Priority, owner: string, ttlMs?: number): Promise<void>  // never rejects
HubEngine.recordConsumer(consumer: HubConsumer, outcome: HubOutcome, count?: number): void

// quote-poller.ts
QuotePollerDeps.onPrice?: (p: Price) => void

// market-hub.service.ts — MarketHubService implements HubPriceSource
MarketHubService.hubFor(userId: string | null, consumer: HubConsumer): HubPrices | null
MarketHubService.record(consumer: HubConsumer, outcome: HubOutcome, count?: number): void
// config: hub.pricesPositions, hub.pricesTracks
```

- [ ] **Step 1: Write the failing tests**

Append inside `describe('HubEngine', …)` in `hub-engine.spec.ts`. The file already has `IST`, `NIFTY`, `POS`, `engine()`, and fake timers at 2026-10-07 10:00 IST.

```typescript
  it('onPrice hears live ticks and polled quotes, and a throwing listener cannot break the others', async () => {
    const { e, broker } = engine();
    await e.start();
    const seen: string[] = [];
    e.onPrice(() => {
      throw new Error('consumer bug');
    });
    const off = e.onPrice((p) => seen.push(`${p.source}:${p.ref.exchange}:${p.ref.token}:${p.ltp}`));
    await e.setPositions([POS]);
    broker.emitTick(FakeBroker.tick('35001', 250.5, 'NFO'));
    // Socket down: P0 is polled on the Critical lane every ~2 s. That price must reach listeners too.
    broker.emitState('reconnecting');
    jest.setSystemTime(Date.now() + 3000);
    await jest.advanceTimersByTimeAsync(4000);
    expect(seen[0]).toBe('ws:NFO:35001:250.5');
    expect(seen.some((s) => s.startsWith('quote:NFO:35001:'))).toBe(true);
    expect(e.status().consumers.listenerErrors).toBeGreaterThanOrEqual(2);
    off();
    const count = seen.length;
    broker.emitState('live');
    broker.emitTick(FakeBroker.tick('35001', 251, 'NFO'));
    expect(seen).toHaveLength(count);
    e.stop();
  });

  it('watchMany registers every ref under one owner with a TTL, and never rejects when the broker is down', async () => {
    const broker = new FakeBroker();
    const { e } = engine(broker);
    await e.start();
    broker.subscribe = async () => {
      throw new Error('not connected');
    };
    const A: InstrumentRef = { exchange: 'NSE', token: '2885', symbol: 'RELIANCE' };
    const B: InstrumentRef = { exchange: 'NSE', token: '1594', symbol: 'INFY' };
    await expect(e.watchMany([A, B], 3, 'track:exit', 120_000)).resolves.toBeUndefined();
    expect(e.price(A, { maxAgeMs: 10_000 })).toEqual({ kind: 'unavailable', reason: 'never-priced' });
    expect(e.price(B, { maxAgeMs: 10_000 })).toEqual({ kind: 'unavailable', reason: 'never-priced' });
    expect(e.status().lastError).toMatch(/not connected/);
    jest.setSystemTime(Date.now() + 120_001);
    await jest.advanceTimersByTimeAsync(30_000); // the maintenance tick expires TTL holders
    expect(e.price(A, { maxAgeMs: 10_000 })).toEqual({ kind: 'unavailable', reason: 'not-watched' });
    e.stop();
  });

  it('counts consumer outcomes per consumer and stamps the last hub-served and unpriced times', async () => {
    const { e } = engine();
    await e.start();
    e.recordConsumer('positions', 'hub', 3);
    e.recordConsumer('positions', 'legacy');
    e.recordConsumer('tracks', 'unpriced', 2);
    e.recordConsumer('tracks', 'hub', 0); // nothing to count: no stamp either
    expect(e.status().consumers).toEqual({
      positions: { hub: 3, legacy: 1, unpriced: 0, lastHubAt: Date.now(), lastUnpricedAt: null },
      tracks: { hub: 0, legacy: 0, unpriced: 2, lastHubAt: null, lastUnpricedAt: Date.now() },
      listenerErrors: 0,
    });
    e.stop();
  });
```

In `quote-poller.spec.ts`:
- change the import line `import type { InstrumentRef } from './hub.types';` to `import type { InstrumentRef, Price } from './hub.types';`;
- change `async function setup(cap: number) {` to `async function setup(cap: number, onPrice?: (p: Price) => void) {`;
- in `setup`, change the poller construction to
  `const poller = new QuotePoller({ feed, book, batcher, clock, nearLiveTargetMs: 5000, criticalTargetMs: 2000, onPrice });`;
- append inside `describe('QuotePoller', …)`:

```typescript
  it('hands every polled price to onPrice, stamped as a quote at receipt', async () => {
    const seen: Price[] = [];
    const { registry, feed, poller } = await setup(0, (p) => seen.push(p));
    registry.watch(ref('1'), 3, 'w', 0);
    await feed.reconcile();
    poller.pollNearLive();
    await jest.advanceTimersByTimeAsync(200);
    // Received when the 150 ms batch fired (t+150), so 50 ms old at t+200.
    expect(seen).toEqual([{ ref: ref('1'), ltp: 100, at: Date.now() - 50, source: 'quote', volume: 0, oi: undefined }]);
  });

  it('does not call onPrice for a throttled quote', async () => {
    const seen: Price[] = [];
    const { broker, registry, feed, poller } = await setup(0, (p) => seen.push(p));
    broker.quoteImpl = async () => {
      throw new AngelThrottleError('rate');
    };
    registry.watch(ref('1'), 3, 'w', 0);
    await feed.reconcile();
    poller.pollNearLive();
    await jest.advanceTimersByTimeAsync(200);
    expect(seen).toEqual([]);
  });
```

Append inside `describe('MarketHubService', …)` in `market-hub.service.spec.ts`, after the existing `enabled` helper:

```typescript
  it('hubFor serves only the owner (or system-wide null) and only for a consumer whose flag is on', () => {
    const svc = new MarketHubService(
      enabled({ 'hub.pricesPositions': true, 'hub.pricesTracks': false }) as any,
      manager() as any,
      tracker as any,
      prisma as any,
      runner as any,
    );
    svc.onModuleInit();
    expect(svc.hubFor('owner', 'positions')).not.toBeNull();
    expect(svc.hubFor(null, 'positions')).not.toBeNull();
    // Never another user's positions from the owner's session.
    expect(svc.hubFor('someone-else', 'positions')).toBeNull();
    // HUB_PRICES_TRACKS is off: that consumer keeps its legacy path.
    expect(svc.hubFor('owner', 'tracks')).toBeNull();
    expect(svc.hubFor(null, 'tracks')).toBeNull();
    svc.onModuleDestroy();
  });

  it('hubFor is null when the hub is not running, whatever the flags say', () => {
    const flags = { 'hub.pricesPositions': true, 'hub.pricesTracks': true };
    const disabled = new MarketHubService(config({ 'hub.enabled': false, ...flags }) as any, manager() as any, tracker as any, prisma as any, runner as any);
    disabled.onModuleInit();
    expect(disabled.hubFor('owner', 'positions')).toBeNull();
    expect(disabled.hubFor(null, 'tracks')).toBeNull();
    const noOwner = new MarketHubService(config({ 'hub.enabled': true, 'hub.ownerUserId': '', ...flags }) as any, manager() as any, tracker as any, prisma as any, runner as any);
    noOwner.onModuleInit();
    expect(noOwner.hubFor(null, 'tracks')).toBeNull();
    // record() without a running hub is a no-op, never a throw.
    expect(() => disabled.record('tracks', 'hub', 1)).not.toThrow();
  });

  it('the owner hub reads the engine, and record() lands in status().consumers', () => {
    const svc = new MarketHubService(
      enabled({ 'hub.pricesPositions': true, 'hub.pricesTracks': true }) as any,
      manager() as any,
      tracker as any,
      prisma as any,
      runner as any,
    );
    svc.onModuleInit();
    const hub = svc.hubFor(null, 'tracks')!;
    const ref = { exchange: 'NSE' as const, token: '2885', symbol: 'RELIANCE' };
    expect(hub.price(ref, { maxAgeMs: 10_000 })).toEqual({ kind: 'unavailable', reason: 'not-watched' });
    void hub.watch([ref], 3, 'track:exit', 120_000);
    expect(hub.price(ref, { maxAgeMs: 10_000 })).toEqual({ kind: 'unavailable', reason: 'never-priced' });
    svc.record('tracks', 'hub', 2);
    svc.record('positions', 'unpriced');
    expect(svc.status()?.consumers.tracks.hub).toBe(2);
    expect(svc.status()?.consumers.positions.unpriced).toBe(1);
    svc.onModuleDestroy();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @td/api test -- hub-engine.spec quote-poller.spec market-hub.service.spec`
Expected: FAIL. `e.watchMany is not a function`; `e.recordConsumer is not a function`; `Cannot read properties of undefined (reading 'listenerErrors')`; the quote-poller `seen` is `[]`; `svc.hubFor is not a function`.

- [ ] **Step 3: Implement**

Create `market-hub/hub-prices.ts`:

```typescript
import type { ModuleRef } from '@nestjs/core';
import type { HubEngine } from './hub-engine';
import type { InstrumentRef, Price, PriceResult, Priority } from './hub.types';

/**
 * How consumers outside market-hub reach the hub's prices without a module
 * import cycle: MarketHubModule imports TradeTrackerModule and MarketDataModule,
 * and SignalGeneratorModule is @Global and imports MarketDataModule. Resolve it
 * lazily with {@link lookupHubPrices}. Everything this file imports is
 * `import type`, so it is safe to import from any module.
 */
export const HUB_PRICE_SOURCE = 'HUB_PRICE_SOURCE';

/** Which consumer switch a caller sits behind: HUB_PRICES_POSITIONS or HUB_PRICES_TRACKS. */
export type HubConsumer = 'positions' | 'tracks';

/** What a consumer did with one instrument: served by the hub, fell back to its legacy tiers, or got nothing. */
export type HubOutcome = 'hub' | 'legacy' | 'unpriced';

/** One broker session's prices (today: the owner's). */
export interface HubPrices {
  price(ref: InstrumentRef, opts: { maxAgeMs: number }): PriceResult;
  prices(refs: readonly InstrumentRef[], opts: { maxAgeMs: number }): Map<string, PriceResult>;
  /**
   * Register (or renew) every ref under `owner`, then reconcile the live slots once.
   * Never rejects: a broker failure lands in status().lastError. Callers on a price
   * path must not await it.
   */
  watch(refs: readonly InstrumentRef[], priority: Priority, owner: string, ttlMs?: number): Promise<void>;
  /** Every price the hub learns (live tick or polled quote). Returns the unsubscribe. */
  onPrice(fn: (p: Price) => void): () => void;
}

export interface HubPriceSource {
  /**
   * THE seam: which hub prices this user's instruments for this consumer.
   * Today: the owner's hub when the hub runs, the consumer's flag is on, and
   * `userId` is HUB_OWNER_USER_ID or null (system-wide paper tracks, which
   * have no user). Otherwise null, and the caller keeps its legacy path.
   * Never another user's session. Multi-tenant: return that user's own hub.
   */
  hubFor(userId: string | null, consumer: HubConsumer): HubPrices | null;
  /** Count outcomes for /healthz/detail → hub.consumers. */
  record(consumer: HubConsumer, outcome: HubOutcome, count?: number): void;
}

/** The hub's price source if this container has the market hub; null otherwise (legacy path). */
export function lookupHubPrices(moduleRef: Pick<ModuleRef, 'get'> | null | undefined): HubPriceSource | null {
  if (!moduleRef) return null;
  try {
    return moduleRef.get<HubPriceSource>(HUB_PRICE_SOURCE, { strict: false }) ?? null;
  } catch {
    return null;
  }
}

/** One engine's prices, as the HubPrices a consumer sees. */
export function engineHubPrices(engine: Pick<HubEngine, 'price' | 'prices' | 'watchMany' | 'onPrice'>): HubPrices {
  return {
    price: (ref, opts) => engine.price(ref, opts),
    prices: (refs, opts) => engine.prices(refs, opts),
    watch: (refs, priority, owner, ttlMs) => engine.watchMany(refs, priority, owner, ttlMs),
    onPrice: (fn) => engine.onPrice(fn),
  };
}
```

In `quote-poller.ts`:
- change the import to `import { LANE, refKey, type InstrumentRef, type Lane, type Price } from './hub.types';`;
- add to `QuotePollerDeps`:

```typescript
  /** Called with every price this poller stores (the engine fans it out to consumers). */
  onPrice?: (p: Price) => void;
```

- replace the `if (o.kind === 'ok') { … }` branch of `apply` with:

```typescript
    if (o.kind === 'ok') {
      const price: Price = {
        ref,
        ltp: o.tick.ltp,
        at: Date.now(),
        source: 'quote',
        volume: o.tick.volume,
        oi: o.tick.oi,
      };
      this.d.book.set(price);
      this.d.onPrice?.(price);
    } else if (o.kind === 'throttled') {
```

(the `else if` branch and everything after it is unchanged.)

In `hub-engine.ts`:
- add `import type { HubConsumer, HubOutcome } from './hub-prices';`;
- add after `CandleStatus`:

```typescript
/** One consumer's outcomes since boot (spec §10: unpriced positions must be visible, never silent). */
export interface ConsumerCounters {
  hub: number;
  legacy: number;
  unpriced: number;
  lastHubAt: number | null;
  lastUnpricedAt: number | null;
}
```

- add to `HubStatus` after `candles`:

```typescript
  /** M3: per consumer, how often the hub served, the legacy path served, or nothing did. */
  consumers: { positions: ConsumerCounters; tracks: ConsumerCounters; listenerErrors: number };
```

- add fields to `HubEngine` (after `lastFixup`):

```typescript
  private readonly priceListeners = new Set<(p: Price) => void>();
  private listenerErrors = 0;
  private readonly consumerCounts: Record<HubConsumer, ConsumerCounters> = {
    positions: { hub: 0, legacy: 0, unpriced: 0, lastHubAt: null, lastUnpricedAt: null },
    tracks: { hub: 0, legacy: 0, unpriced: 0, lastHubAt: null, lastUnpricedAt: null },
  };
```

- in the constructor, add `onPrice: (p) => this.emit(p),` to the `new QuotePoller({ … })` deps, and directly after the `this.feed = new LiveFeed(…)` line add:

```typescript
    this.feed.onPrice((p) => this.emit(p));
```

- replace the existing `onPrice` method with:

```typescript
  /** Every price the hub learns: live ticks AND polled quotes (WS-down P0/P1, near-live). */
  onPrice(fn: (p: Price) => void): () => void {
    this.priceListeners.add(fn);
    return () => {
      this.priceListeners.delete(fn);
    };
  }

  /** A consumer's bug must not stop the feed, the other consumers or the candle builder. */
  private emit(p: Price): void {
    for (const fn of this.priceListeners) {
      try {
        fn(p);
      } catch {
        this.listenerErrors++;
      }
    }
  }

  /** Register several watches, then reconcile once. Never rejects (the failure is in status().lastError). */
  async watchMany(refs: readonly InstrumentRef[], priority: Priority, owner: string, ttlMs?: number): Promise<void> {
    const now = Date.now();
    for (const r of refs) this.registry.watch(r, priority, owner, now, ttlMs);
    await this.reconcileSafely();
  }

  recordConsumer(consumer: HubConsumer, outcome: HubOutcome, count = 1): void {
    if (!(count > 0)) return;
    const c = this.consumerCounts[consumer];
    c[outcome] += count;
    if (outcome === 'hub') c.lastHubAt = Date.now();
    if (outcome === 'unpriced') c.lastUnpricedAt = Date.now();
  }
```

- in `status()`, add to the returned object after `candles: this.candleStatus(),`:

```typescript
      consumers: {
        positions: { ...this.consumerCounts.positions },
        tracks: { ...this.consumerCounts.tracks },
        listenerErrors: this.listenerErrors,
      },
```

In `configuration.ts`, inside `hub: { … }` after `servesCharts`:

```typescript
    // M3 consumer switch: trade-tracker sweep + hub tick listener + sentinel tick source read
    // the hub's prices for the owner's positions. Needs MARKET_HUB_ENABLED. Off = legacy path.
    pricesPositions: process.env.HUB_PRICES_POSITIONS === 'true',
    // M3 consumer switch: ExitPriceService (track pollers, breakout-swing, EOD square-offs)
    // reads the hub's prices. Needs MARKET_HUB_ENABLED. Off = legacy path.
    pricesTracks: process.env.HUB_PRICES_TRACKS === 'true',
```

In `deploy/env/api.env.example`, change the line
`# M2 adds the CandleStore behind its own two flags below (HUB_CANDLES_ENABLED, HUB_SERVES_CHARTS).`
to
`# M2 adds the CandleStore behind HUB_CANDLES_ENABLED / HUB_SERVES_CHARTS; M3 adds HUB_PRICES_POSITIONS / HUB_PRICES_TRACKS.`
and append after `HUB_SERVES_CHARTS=false`:

```bash
# SP1 M3 switches (each needs MARKET_HUB_ENABLED=true; set false to revert that consumer for a session).
# Trade-tracker sweep + hub tick listener + sentinel tick source read the hub's prices for YOUR positions.
HUB_PRICES_POSITIONS=false
# ExitPriceService (track pollers, breakout-swing, EOD square-offs) reads the hub's prices.
HUB_PRICES_TRACKS=false
```

In `market-hub.service.ts`:
- add the import `import { engineHubPrices, type HubConsumer, type HubOutcome, type HubPriceSource, type HubPrices } from './hub-prices';`;
- change the class declaration to `export class MarketHubService implements OnModuleInit, OnModuleDestroy, HubCandleSource, HubPriceSource {`;
- add fields after `private timers…`:

```typescript
  private ownerUserId: string | null = null;
  private ownerHub: HubPrices | null = null;
```

- in `onModuleInit`, directly after `this.engine = engine;` add:

```typescript
    this.ownerUserId = owner;
    this.ownerHub = engineHubPrices(engine);
```

- add the methods after `unwatch(…)`:

```typescript
  /** See HubPriceSource.hubFor. Personal MVP: only the owner's hub exists. */
  hubFor(userId: string | null, consumer: HubConsumer): HubPrices | null {
    if (!this.engine || !this.ownerHub || !this.ownerUserId) return null;
    if (!this.consumerEnabled(consumer)) return null;
    if (userId !== null && userId !== this.ownerUserId) return null;
    return this.ownerHub;
  }

  record(consumer: HubConsumer, outcome: HubOutcome, count = 1): void {
    this.engine?.recordConsumer(consumer, outcome, count);
  }

  private consumerEnabled(consumer: HubConsumer): boolean {
    const key = consumer === 'positions' ? 'hub.pricesPositions' : 'hub.pricesTracks';
    return this.config.get<boolean>(key) === true;
  }
```

- extend the class doc comment with the sentence: `M3: prices the owner's positions and the system-wide strategy tracks for consumers behind HUB_PRICES_POSITIONS / HUB_PRICES_TRACKS through the HUB_PRICE_SOURCE token (see hub-prices.ts).`

Replace `market-hub.module.ts` with:

```typescript
import { Module } from '@nestjs/common';
import { MarketDataModule } from '../market-data/market-data.module';
import { TradeTrackerModule } from '../trade-tracker/trade-tracker.module';
import { HUB_CANDLE_SOURCE } from './hub-candle-source';
import { HUB_PRICE_SOURCE } from './hub-prices';
import { MarketHubService } from './market-hub.service';

/**
 * SP1 market data hub. M1 = shadow prices; M2 = CandleStore behind
 * HUB_CANDLES_ENABLED, serving /candles behind HUB_SERVES_CHARTS through the
 * HUB_CANDLE_SOURCE token; M3 = position and track prices through the
 * HUB_PRICE_SOURCE token behind HUB_PRICES_POSITIONS / HUB_PRICES_TRACKS.
 * Consumers resolve both tokens lazily: this module imports MarketDataModule
 * and TradeTrackerModule, so a direct injection would cycle.
 */
@Module({
  imports: [MarketDataModule, TradeTrackerModule],
  providers: [
    MarketHubService,
    { provide: HUB_CANDLE_SOURCE, useExisting: MarketHubService },
    { provide: HUB_PRICE_SOURCE, useExisting: MarketHubService },
  ],
  exports: [MarketHubService, HUB_CANDLE_SOURCE, HUB_PRICE_SOURCE],
})
export class MarketHubModule {}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @td/api test -- hub-engine.spec quote-poller.spec market-hub.service.spec`
Expected: PASS (old and new tests).
Run: `pnpm --filter @td/api test -- market-hub health`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/market-hub/hub-prices.ts apps/api/src/modules/market-hub/hub-engine.ts apps/api/src/modules/market-hub/hub-engine.spec.ts apps/api/src/modules/market-hub/quote-poller.ts apps/api/src/modules/market-hub/quote-poller.spec.ts apps/api/src/modules/market-hub/market-hub.service.ts apps/api/src/modules/market-hub/market-hub.service.spec.ts apps/api/src/modules/market-hub/market-hub.module.ts apps/api/src/config/configuration.ts deploy/env/api.env.example
git commit -m "feat(market-hub): hubFor seam, HUB_PRICES_* switches, consumer counters in status" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/market-hub/hub-prices.ts apps/api/src/modules/market-hub/hub-engine.ts apps/api/src/modules/market-hub/hub-engine.spec.ts apps/api/src/modules/market-hub/quote-poller.ts apps/api/src/modules/market-hub/quote-poller.spec.ts apps/api/src/modules/market-hub/market-hub.service.ts apps/api/src/modules/market-hub/market-hub.service.spec.ts apps/api/src/modules/market-hub/market-hub.module.ts apps/api/src/config/configuration.ts deploy/env/api.env.example
```

---

### Task 2: Underlying resolver and the one index map

**Files:**
- Create: `apps/api/src/modules/market-hub/underlying.ts`
- Test: `apps/api/src/modules/market-hub/underlying.spec.ts`
- Modify: `apps/api/src/modules/market-data/repositories/market-data.repository.ts` (`getInstrumentByToken`)
- Test: `apps/api/src/modules/market-data/repositories/market-data.repository.spec.ts` (new)

**Interfaces:**
- Consumes: `INDICES` (`@td/shared/constants`: NIFTY 99926000, BANKNIFTY 99926009, FINNIFTY 99926037 on NSE; SENSEX 99919000 on BSE); MIDCPNIFTY 99926074 NSE (from `market-context.service.ts` `UNDERLYING_TOKEN_MAP`, absent from `INDICES`); `InstrumentRef`, `HubExchange` (`hub.types.ts`).
- Produces:

```typescript
export const INDEX_UNDERLYINGS: Readonly<Record<string, InstrumentRef>>;
export function isDerivative(c: { exchange: string; symbol: string }): boolean;
export interface UnderlyingLookup {
  contract(exchange: string, token: string): Promise<{ name: string | null } | null>;
  cash(symbol: string, exchange: string): Promise<{ token: string; symbol?: string | null } | null>;
}
export interface ResolvedUnderlying { name: string | null; ref: InstrumentRef | null }
export function resolveUnderlying(contract: { exchange: string; token: string; symbol: string }, lookup: UnderlyingLookup): Promise<ResolvedUnderlying>;
// MarketDataRepository
getInstrumentByToken(token: string, exchange?: string): Promise<Instrument | null>;
```

- [ ] **Step 1: Write the failing tests**

Create `market-hub/underlying.spec.ts`:

```typescript
import { INDEX_UNDERLYINGS, isDerivative, resolveUnderlying, type UnderlyingLookup } from './underlying';

function lookup(name: string | null, cash: Record<string, string> = {}) {
  const l = {
    contract: jest.fn(async (_exchange: string, _token: string) => (name === null ? null : { name })),
    cash: jest.fn(async (symbol: string, exchange: string) => {
      const token = cash[`${exchange}:${symbol}`];
      return token ? { token, symbol } : null;
    }),
  };
  return l as typeof l & UnderlyingLookup;
}

describe('the one index map', () => {
  it('carries every index that has options, with the Angel tokens the rest of the code uses', () => {
    expect(INDEX_UNDERLYINGS).toEqual({
      NIFTY: { exchange: 'NSE', token: '99926000', symbol: 'NIFTY' },
      BANKNIFTY: { exchange: 'NSE', token: '99926009', symbol: 'BANKNIFTY' },
      FINNIFTY: { exchange: 'NSE', token: '99926037', symbol: 'FINNIFTY' },
      MIDCPNIFTY: { exchange: 'NSE', token: '99926074', symbol: 'MIDCPNIFTY' },
      SENSEX: { exchange: 'BSE', token: '99919000', symbol: 'SENSEX' },
    });
  });
});

describe('isDerivative', () => {
  it('reads the segment, or a strike/expiry suffix after a digit', () => {
    expect(isDerivative({ exchange: 'NFO', symbol: 'NIFTY26OCT25000CE' })).toBe(true);
    expect(isDerivative({ exchange: 'MCX', symbol: 'CRUDEOIL26OCTFUT' })).toBe(true);
    expect(isDerivative({ exchange: 'bfo', symbol: 'SENSEX26OCT81000PE' })).toBe(true);
    expect(isDerivative({ exchange: '', symbol: 'RELIANCE28OCT26FUT' })).toBe(true);
    // 'RELIANCE' ends in "CE" but has no digit before it: a company, not a contract.
    expect(isDerivative({ exchange: 'NSE', symbol: 'RELIANCE' })).toBe(false);
    expect(isDerivative({ exchange: 'NSE', symbol: 'RELIANCE-EQ' })).toBe(false);
  });
});

describe('resolveUnderlying', () => {
  it('resolves an index option to the index token from the one map, with no cash lookup', async () => {
    const l = lookup('NIFTY');
    const r = await resolveUnderlying({ exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' }, l);
    expect(r).toEqual({ name: 'NIFTY', ref: { exchange: 'NSE', token: '99926000', symbol: 'NIFTY' } });
    // Index rows are not in `instruments`: a cash lookup would find nothing and lose the spot.
    expect(l.cash).not.toHaveBeenCalled();
  });

  it('looks the contract up WITH its exchange (tokens collide across segments)', async () => {
    const l = lookup('BANKNIFTY');
    await resolveUnderlying({ exchange: 'nfo', token: '35002', symbol: 'BANKNIFTY26OCT52000PE' }, l);
    expect(l.contract).toHaveBeenCalledWith('NFO', '35002');
  });

  it('resolves SENSEX to BSE and MIDCPNIFTY to its own token', async () => {
    expect((await resolveUnderlying({ exchange: 'BFO', token: '1', symbol: 'SENSEX26OCT81000CE' }, lookup('SENSEX'))).ref).toEqual({
      exchange: 'BSE',
      token: '99919000',
      symbol: 'SENSEX',
    });
    expect((await resolveUnderlying({ exchange: 'NFO', token: '2', symbol: 'MIDCPNIFTY26OCT13000CE' }, lookup('midcpnifty'))).ref).toEqual({
      exchange: 'NSE',
      token: '99926074',
      symbol: 'MIDCPNIFTY',
    });
  });

  it('resolves a stock option to its NSE cash row, -EQ first, then the bare name', async () => {
    const eq = lookup('KEI', { 'NSE:KEI-EQ': '13310' });
    expect(await resolveUnderlying({ exchange: 'NFO', token: '77', symbol: 'KEI29SEP265800CE' }, eq)).toEqual({
      name: 'KEI',
      ref: { exchange: 'NSE', token: '13310', symbol: 'KEI-EQ' },
    });
    const bare = lookup('KEI', { 'NSE:KEI': '13310' });
    const r = await resolveUnderlying({ exchange: 'NFO', token: '77', symbol: 'KEI29SEP265800CE' }, bare);
    expect(bare.cash.mock.calls).toEqual([
      ['KEI-EQ', 'NSE'],
      ['KEI', 'NSE'],
    ]);
    expect(r.ref).toEqual({ exchange: 'NSE', token: '13310', symbol: 'KEI' });
  });

  it('keeps the name when no cash row matches (the level book and the news still work)', async () => {
    expect(await resolveUnderlying({ exchange: 'NFO', token: '77', symbol: 'KEI29SEP265800CE' }, lookup('KEI'))).toEqual({
      name: 'KEI',
      ref: null,
    });
  });

  it('gives an MCX future its name but no underlying ref, without a cash lookup', async () => {
    const l = lookup('CRUDEOIL');
    expect(await resolveUnderlying({ exchange: 'MCX', token: '448', symbol: 'CRUDEOIL26OCTFUT' }, l)).toEqual({
      name: 'CRUDEOIL',
      ref: null,
    });
    expect(l.cash).not.toHaveBeenCalled();
  });

  it('a contract missing from the master resolves to nothing', async () => {
    expect(await resolveUnderlying({ exchange: 'NFO', token: '9', symbol: 'X26OCT1CE' }, lookup(null))).toEqual({ name: null, ref: null });
  });

  it('lets a lookup failure through, so the caller decides whether to cache', async () => {
    const l = lookup('KEI');
    l.contract.mockRejectedValueOnce(new Error('db down'));
    await expect(resolveUnderlying({ exchange: 'NFO', token: '77', symbol: 'KEI29SEP265800CE' }, l)).rejects.toThrow('db down');
  });
});
```

Create `market-data/repositories/market-data.repository.spec.ts`:

```typescript
import { MarketDataRepository } from './market-data.repository';

describe('MarketDataRepository.getInstrumentByToken', () => {
  it('filters by exchange when given one (tokens collide across segments), and not otherwise', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const repo = new MarketDataRepository({ instrument: { findFirst } } as never);
    await repo.getInstrumentByToken('35001', 'NFO');
    expect(findFirst).toHaveBeenLastCalledWith({ where: { token: '35001', exchange: 'NFO', isActive: true } });
    await repo.getInstrumentByToken('35001');
    expect(findFirst).toHaveBeenLastCalledWith({ where: { token: '35001', isActive: true } });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @td/api test -- underlying.spec market-data.repository.spec`
Expected: FAIL. `Cannot find module './underlying'`; the repository test's first assertion fails (no `exchange` in `where`).

- [ ] **Step 3: Implement**

Create `market-hub/underlying.ts`:

```typescript
import { INDICES } from '@td/shared/constants';
import type { HubExchange, InstrumentRef } from './hub.types';

/**
 * THE index map for derivative underlyings, keyed by the instrument master's
 * `name` for the index's options and futures. Index rows are NOT in the
 * `instruments` table, so these can never come from a cash lookup (the
 * production warning "resolved … to underlying NIFTY, but no NSE cash/index
 * instrument" was exactly that lookup failing).
 *
 * NIFTY/BANKNIFTY/FINNIFTY/SENSEX come from packages/shared INDICES.
 * MIDCPNIFTY is not in INDICES; its token is the one market-context.service.ts
 * (UNDERLYING_TOKEN_MAP) already uses. `NIFTY MIDCAP 50` (99926025) is a
 * different index and has no options here.
 */
export const INDEX_UNDERLYINGS: Readonly<Record<string, InstrumentRef>> = Object.freeze({
  NIFTY: { exchange: INDICES.NIFTY_50.exchange, token: INDICES.NIFTY_50.token, symbol: INDICES.NIFTY_50.symbol },
  BANKNIFTY: { exchange: INDICES.BANK_NIFTY.exchange, token: INDICES.BANK_NIFTY.token, symbol: INDICES.BANK_NIFTY.symbol },
  FINNIFTY: { exchange: INDICES.FIN_NIFTY.exchange, token: INDICES.FIN_NIFTY.token, symbol: INDICES.FIN_NIFTY.symbol },
  MIDCPNIFTY: { exchange: 'NSE', token: '99926074', symbol: 'MIDCPNIFTY' },
  SENSEX: { exchange: INDICES.SENSEX.exchange, token: INDICES.SENSEX.token, symbol: INDICES.SENSEX.symbol },
});

const DERIVATIVE_EXCHANGES: ReadonlySet<string> = new Set(['NFO', 'BFO', 'MCX']);
/** A strike or expiry is always a digit before CE/PE/FUT; `RELIANCE` must not match. */
const CONTRACT_SUFFIX = /\d(CE|PE|FUT)$/;

/** True for an F&O or commodity contract (which has an underlying); false for cash. */
export function isDerivative(c: { exchange: string; symbol: string }): boolean {
  return DERIVATIVE_EXCHANGES.has(String(c.exchange ?? '').toUpperCase()) || CONTRACT_SUFFIX.test(String(c.symbol ?? '').toUpperCase());
}

/** The two instrument-master reads the resolver needs. */
export interface UnderlyingLookup {
  /** The contract's own master row, filtered by exchange. */
  contract(exchange: string, token: string): Promise<{ name: string | null } | null>;
  /** A cash instrument by exact symbol on one exchange. */
  cash(symbol: string, exchange: string): Promise<{ token: string; symbol?: string | null } | null>;
}

export interface ResolvedUnderlying {
  /** The master's underlying name ('NIFTY', 'KEI'); null when the contract is not in the master. */
  name: string | null;
  /** Where the underlying's price lives; null for MCX (no cash underlying) or when nothing matches. */
  ref: InstrumentRef | null;
}

/**
 * A derivative's underlying: index names from {@link INDEX_UNDERLYINGS}; stocks
 * from the NSE cash row by the master's name (`NAME-EQ`, then `NAME`); MCX
 * contracts have none. Lookup failures are thrown, never cached here: the
 * caller decides (a cached failure would blind a position for the process's life).
 */
export async function resolveUnderlying(
  contract: { exchange: string; token: string; symbol: string },
  lookup: UnderlyingLookup,
): Promise<ResolvedUnderlying> {
  const exchange = String(contract.exchange ?? '').toUpperCase();
  const row = await lookup.contract(exchange, contract.token);
  const name = row?.name ? row.name.trim().toUpperCase() : null;
  if (!name) return { name: null, ref: null };
  if (exchange === 'MCX') return { name, ref: null };
  const index = INDEX_UNDERLYINGS[name];
  if (index) return { name, ref: { ...index } };
  const cashExchange: HubExchange = 'NSE';
  const cash = (await lookup.cash(`${name}-EQ`, cashExchange)) ?? (await lookup.cash(name, cashExchange));
  if (!cash?.token) return { name, ref: null };
  return { name, ref: { exchange: cashExchange, token: cash.token, symbol: cash.symbol || name } };
}
```

In `market-data.repository.ts`, replace `getInstrumentByToken` with:

```typescript
  /**
   * Get a single instrument by its token, optionally on one exchange. Pass the
   * exchange whenever it is known: tokens collide across segments (an NSE cash
   * token can equal an NFO or MCX contract token).
   */
  async getInstrumentByToken(token: string, exchange?: string) {
    return this.prisma.instrument.findFirst({
      where: exchange ? { token, exchange, isActive: true } : { token, isActive: true },
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @td/api test -- underlying.spec market-data.repository.spec`
Expected: PASS (9 + 1 tests).
Run: `pnpm --filter @td/api test -- market-data trade-sentinel`
Expected: PASS (existing callers pass no exchange and are unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/market-hub/underlying.ts apps/api/src/modules/market-hub/underlying.spec.ts apps/api/src/modules/market-data/repositories/market-data.repository.ts apps/api/src/modules/market-data/repositories/market-data.repository.spec.ts
git commit -m "feat(market-hub): one index map and an exchange-filtered underlying resolver" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/market-hub/underlying.ts apps/api/src/modules/market-hub/underlying.spec.ts apps/api/src/modules/market-data/repositories/market-data.repository.ts apps/api/src/modules/market-data/repositories/market-data.repository.spec.ts
```

---

### Task 3: Open positions with symbols; underlyings watched at priority 1

**Files:**
- Modify: `apps/api/src/modules/trade-tracker/services/trade-tracker.service.ts` (`openPositionRefsByUser`, `openTrackerRefsByUser`, cache)
- Modify: `apps/api/src/modules/trade-tracker/services/trade-tracker.service.spec.ts`
- Modify: `apps/api/src/modules/market-hub/hub-engine.ts` (`setPositions`)
- Modify: `apps/api/src/modules/market-hub/hub-engine.spec.ts`
- Modify: `apps/api/src/modules/market-hub/market-hub.service.ts` (constructor, `refreshPositions`)
- Modify: `apps/api/src/modules/market-hub/market-hub.service.spec.ts`

**Interfaces:**
- Consumes: `resolveUnderlying`, `isDerivative` (Task 2); `MarketDataRepository.getInstrumentByToken(token, exchange)` and `getInstrumentBySymbol(symbol, exchange)`; `isHubExchange`, `refKey` (`hub.types.ts`).
- Produces:

```typescript
// trade-tracker.service.ts
export interface PositionRef { exchange: string; token: string; symbol: string }
TradeTrackerService.openPositionRefsByUser(): Promise<Map<string, PositionRef[]>>   // cached 60 s, shared with:
TradeTrackerService.openTrackerRefsByUser(): Promise<Map<string, TokenRef[]>>       // unchanged output shape
// hub-engine.ts
HubEngine.setPositions(refs: readonly InstrumentRef[], underlyings?: readonly InstrumentRef[]): Promise<void>
// market-hub.service.ts
constructor(config, manager, tracker, prisma, jobs, instruments: MarketDataRepository)
```

- [ ] **Step 1: Write the failing tests**

In `trade-tracker.service.spec.ts`, append inside `describe('TradeTrackerService', …)` (after `describe('openTrackerRefsByUser', …)`):

```typescript
  describe('openPositionRefsByUser', () => {
    it('carries each instrument’s symbol, keeps one token on two exchanges as two instruments, and shares the cache', async () => {
      prisma.tradeTracker.findMany.mockResolvedValue([
        { userId: 'owner', token: '35001', symbol: 'NIFTY26OCT25000CE', exchange: 'NFO', kind: 'POSITION' },
        { userId: 'owner', token: '35001', symbol: 'CRUDEOIL26OCTFUT', exchange: 'MCX', kind: 'POSITION' },
        { userId: 'owner', token: '2885', symbol: 'RELIANCE-EQ', exchange: 'NSE', kind: 'HOLDING' },
      ]);

      expect((await service.openPositionRefsByUser()).get('owner')).toEqual([
        { exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' },
        { exchange: 'MCX', token: '35001', symbol: 'CRUDEOIL26OCTFUT' },
        { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ' },
      ]);
      expect((await service.openTrackerRefsByUser()).get('owner')).toEqual([
        { token: '35001', exchange: 'NFO' },
        { token: '35001', exchange: 'MCX' },
        { token: '2885', exchange: 'NSE' },
      ]);
      // One database read serves both views.
      expect(prisma.tradeTracker.findMany).toHaveBeenCalledTimes(1);
    });

    it('falls back to the token when the broker gave no tradingsymbol', async () => {
      prisma.tradeTracker.findMany.mockResolvedValue([
        { userId: 'owner', token: '35001', symbol: '', exchange: 'NFO', kind: 'POSITION' },
      ]);
      expect((await service.openPositionRefsByUser()).get('owner')).toEqual([{ exchange: 'NFO', token: '35001', symbol: '35001' }]);
    });
  });
```

In `hub-engine.spec.ts`, change `import type { InstrumentRef } from './hub.types';` to `import { refKey, type InstrumentRef } from './hub.types';` and append inside `describe('HubEngine', …)`:

```typescript
  it('watches underlyings at priority 1 under the positions owner; a held contract stays priority 0', async () => {
    const { e, broker } = engine();
    await e.start();
    const RELIANCE: InstrumentRef = { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ' };
    const RELFUT: InstrumentRef = { exchange: 'NFO', token: '57001', symbol: 'RELIANCE28OCT26FUT' };
    await e.setPositions([POS, RELFUT, RELIANCE], [NIFTY, RELIANCE]);
    const pri = new Map(e.registry.entries().map((x) => [refKey(x.ref), x.priority]));
    expect(pri.get('NFO:35001')).toBe(0);
    expect(pri.get('NFO:57001')).toBe(0);
    expect(pri.get('NSE:99926000')).toBe(1); // context (P2) + underlying (P1): served as P1
    expect(pri.get('NSE:2885')).toBe(0); // held in cash AND an underlying: the position wins
    expect(broker.subscribed.has('NSE:2885')).toBe(true);
    await e.setPositions([], []);
    const after = new Map(e.registry.entries().map((x) => [refKey(x.ref), x.priority]));
    expect(after.get('NSE:99926000')).toBe(2); // back to context only
    expect(after.has('NSE:2885')).toBe(false);
    expect(after.has('NFO:35001')).toBe(false);
    e.stop();
  });
```

In `market-hub.service.spec.ts`:
- replace `const tracker = { openTrackerRefsByUser: jest.fn().mockResolvedValue(new Map()) };` with

```typescript
const tracker = {
  openTrackerRefsByUser: jest.fn().mockResolvedValue(new Map()),
  openPositionRefsByUser: jest.fn().mockResolvedValue(new Map()),
};
const instruments = { getInstrumentByToken: jest.fn().mockResolvedValue(null), getInstrumentBySymbol: jest.fn().mockResolvedValue(null) };
```

- pass `instruments as any` as a **sixth** constructor argument in every existing `new MarketHubService(…)` call in the file, including the three added in Task 1;
- append inside `describe('MarketHubService', …)`:

```typescript
  it('watches the owner’s positions with their real symbols, and an index option’s underlying at priority 1', async () => {
    const start = jest.spyOn(HubEngine.prototype, 'start').mockResolvedValue(undefined);
    const setPositions = jest.spyOn(HubEngine.prototype, 'setPositions').mockResolvedValue(undefined);
    const positions = {
      openTrackerRefsByUser: jest.fn(),
      openPositionRefsByUser: jest.fn().mockResolvedValue(
        new Map([
          [
            'owner',
            [
              { exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' },
              { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ' },
              { exchange: 'CDS', token: '1', symbol: 'USDINR26OCTFUT' }, // not a hub exchange
            ],
          ],
          ['someone-else', [{ exchange: 'NFO', token: '99', symbol: 'BANKNIFTY26OCT52000PE' }]],
        ]),
      ),
    };
    const lookups = { getInstrumentByToken: jest.fn().mockResolvedValue({ name: 'NIFTY' }), getInstrumentBySymbol: jest.fn() };
    const svc = new MarketHubService(enabled() as any, manager() as any, positions as any, prisma as any, runner as any, lookups as any);
    svc.onModuleInit();
    await new Promise((r) => setImmediate(r));
    expect(setPositions).toHaveBeenCalledWith(
      [
        { exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' },
        { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ' },
      ],
      [{ exchange: 'NSE', token: '99926000', symbol: 'NIFTY' }],
    );
    // The contract is looked up WITH its exchange; an index needs no cash row; cash has no underlying.
    expect(lookups.getInstrumentByToken).toHaveBeenCalledTimes(1);
    expect(lookups.getInstrumentByToken).toHaveBeenCalledWith('35001', 'NFO');
    expect(lookups.getInstrumentBySymbol).not.toHaveBeenCalled();
    svc.onModuleDestroy();
    start.mockRestore();
    setPositions.mockRestore();
  });

  it('a failed underlying lookup still watches the position, and is retried on the next refresh', async () => {
    const start = jest.spyOn(HubEngine.prototype, 'start').mockResolvedValue(undefined);
    const setPositions = jest.spyOn(HubEngine.prototype, 'setPositions').mockResolvedValue(undefined);
    const positions = {
      openTrackerRefsByUser: jest.fn(),
      openPositionRefsByUser: jest.fn().mockResolvedValue(new Map([['owner', [{ exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' }]]])),
    };
    const lookups = {
      getInstrumentByToken: jest.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue({ name: 'NIFTY' }),
      getInstrumentBySymbol: jest.fn(),
    };
    const svc = new MarketHubService(enabled() as any, manager() as any, positions as any, prisma as any, runner as any, lookups as any);
    svc.onModuleInit();
    await new Promise((r) => setImmediate(r));
    expect(setPositions).toHaveBeenLastCalledWith([{ exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' }], []);
    // White-box: refreshPositions runs from a 60 s timer; call it directly for the retry.
    await (svc as unknown as { refreshPositions(owner: string): Promise<void> }).refreshPositions('owner');
    expect(setPositions).toHaveBeenLastCalledWith(
      [{ exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' }],
      [{ exchange: 'NSE', token: '99926000', symbol: 'NIFTY' }],
    );
    svc.onModuleDestroy();
    start.mockRestore();
    setPositions.mockRestore();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @td/api test -- trade-tracker.service.spec hub-engine.spec market-hub.service.spec`
Expected: FAIL. `service.openPositionRefsByUser is not a function`; the engine test gets priority 0 for `NSE:99926000` (underlyings ignored); the service test sees `setPositions` called with `symbol: '35001'` and one argument.

- [ ] **Step 3: Implement**

In `trade-tracker.service.ts`:
- add after `BookItem`:

```typescript
/** An open tracker's instrument with its broker tradingsymbol (the hub's watch set). */
export interface PositionRef {
  exchange: string;
  token: string;
  symbol: string;
}
```

- change the `openRefsCache` field type to `{ byUser: Map<string, PositionRef[]>; at: number } | null = null;`
- replace `openTrackerRefsByUser()` (keep its doc comment, and add the line `Derived from {@link openPositionRefsByUser}: one query and one cache serve both.` to it) with the two methods below:

```typescript
  async openTrackerRefsByUser(): Promise<Map<string, TokenRef[]>> {
    const byUser = await this.openPositionRefsByUser();
    return new Map([...byUser].map(([u, refs]) => [u, refs.map((r) => ({ token: r.token, exchange: r.exchange }))]));
  }

  /**
   * Every OPEN tracker's instrument WITH its tradingsymbol, grouped by owning
   * user and ordered by {@link byFeedPriority}. The hub watches the owner's set
   * at priority 0. One token held on two exchanges is two instruments; one
   * instrument held as a POSITION and a HOLDING is one. Cached for
   * {@link OPEN_TOKENS_TTL_MS} and invalidated with the token queue.
   */
  async openPositionRefsByUser(): Promise<Map<string, PositionRef[]>> {
    const cached = this.openRefsCache;
    if (cached && Date.now() - cached.at < OPEN_TOKENS_TTL_MS) {
      return new Map([...cached.byUser].map(([u, refs]) => [u, refs.map((r) => ({ ...r }))]));
    }

    const rows = await this.prisma.tradeTracker.findMany({
      where: { status: 'OPEN' },
      select: { userId: true, token: true, symbol: true, exchange: true, kind: true },
    });

    const byUser = new Map<string, PositionRef[]>();
    for (const row of [...rows].sort(byFeedPriority)) {
      if (!row.userId || !row.token || !row.exchange) continue;
      const refs = byUser.get(row.userId) ?? [];
      const exchange = row.exchange.toUpperCase();
      if (!refs.some((r) => r.token === row.token && r.exchange.toUpperCase() === exchange)) {
        refs.push({ exchange: row.exchange, token: row.token, symbol: row.symbol || row.token });
      }
      byUser.set(row.userId, refs);
    }

    this.openRefsCache = { byUser, at: Date.now() };
    return new Map([...byUser].map(([u, refs]) => [u, refs.map((r) => ({ ...r }))]));
  }
```

In `hub-engine.ts`:
- change the field to `private positions = new Map<string, { ref: InstrumentRef; priority: Priority }>();`
- replace `setPositions` with:

```typescript
  /**
   * Replace the open-position set: contracts at priority 0 and their underlyings
   * at priority 1, all under one owner, so neither is ever demoted (spec §5.1).
   * An instrument that is both (a cash holding that is also an option's
   * underlying) stays priority 0.
   */
  async setPositions(refs: readonly InstrumentRef[], underlyings: readonly InstrumentRef[] = []): Promise<void> {
    const next = new Map<string, { ref: InstrumentRef; priority: Priority }>();
    for (const r of underlyings) next.set(refKey(r), { ref: r, priority: 1 });
    for (const r of refs) next.set(refKey(r), { ref: r, priority: 0 });
    const now = Date.now();
    for (const [k, e] of this.positions) if (!next.has(k)) this.registry.unwatch(e.ref, POSITIONS);
    for (const e of next.values()) this.registry.watch(e.ref, e.priority, POSITIONS, now);
    this.positions = next;
    await this.feed.reconcile();
  }
```

In `market-hub.service.ts`:
- add imports `import { MarketDataRepository } from '../market-data/repositories/market-data.repository';` and `import { isDerivative, resolveUnderlying } from './underlying';`; change the `./hub.types` import to `import { LANE, isHubExchange, refKey, type HubExchange, type InstrumentRef, type PriceResult, type Priority } from './hub.types';`;
- delete the now-unused `const HUB_EXCHANGES = new Set<HubExchange>([…]);` line and add `const MAX_UNDERLYING_CACHE = 1000;`;
- add the field `private readonly underlyings = new Map<string, InstrumentRef | null>();`;
- add `private readonly instruments: MarketDataRepository,` as the last constructor parameter (after `jobs`);
- replace `refreshPositions` with:

```typescript
  /**
   * The owner's open positions at priority 0 with their real tradingsymbols,
   * and each derivative's underlying at priority 1 (spec §5.1). A failed
   * underlying lookup never drops the position itself.
   */
  private async refreshPositions(owner: string): Promise<void> {
    if (!this.engine) return;
    try {
      const byUser = await this.tracker.openPositionRefsByUser();
      const refs: InstrumentRef[] = [];
      for (const p of byUser.get(owner) ?? []) {
        const exchange = p.exchange.toUpperCase();
        if (!isHubExchange(exchange)) continue;
        refs.push({ exchange, token: p.token, symbol: p.symbol });
      }
      const underlyings: InstrumentRef[] = [];
      for (const r of refs) {
        if (!isDerivative(r)) continue;
        const u = await this.underlyingOf(r);
        if (u) underlyings.push(u);
      }
      await this.engine.setPositions(refs, underlyings);
    } catch (err) {
      this.logger.warn(`Market hub position refresh failed: ${(err as Error)?.message ?? err}`);
    }
  }

  /** Memoised per contract (the master does not change intraday); a failure is not cached. */
  private async underlyingOf(ref: InstrumentRef): Promise<InstrumentRef | null> {
    const key = refKey(ref);
    if (this.underlyings.has(key)) return this.underlyings.get(key) ?? null;
    try {
      const { ref: underlying } = await resolveUnderlying(ref, {
        contract: (exchange, token) => this.instruments.getInstrumentByToken(token, exchange),
        cash: (symbol, exchange) => this.instruments.getInstrumentBySymbol(symbol, exchange),
      });
      if (this.underlyings.size >= MAX_UNDERLYING_CACHE) this.underlyings.clear();
      this.underlyings.set(key, underlying);
      return underlying;
    } catch (err) {
      this.logger.warn(`Underlying lookup failed for ${ref.symbol} (${key}): ${(err as Error)?.message ?? err}`);
      return null;
    }
  }
```

(`HubExchange` stays imported: `onModuleInit`'s `defaults` mapping still casts `i.exchange as HubExchange`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @td/api test -- trade-tracker.service.spec hub-engine.spec market-hub.service.spec`
Expected: PASS (old and new; the existing `openTrackerRefsByUser` tests are unchanged).
Run: `pnpm --filter @td/api test -- market-hub trade-tracker health`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-tracker/services/trade-tracker.service.ts apps/api/src/modules/trade-tracker/services/trade-tracker.service.spec.ts apps/api/src/modules/market-hub/hub-engine.ts apps/api/src/modules/market-hub/hub-engine.spec.ts apps/api/src/modules/market-hub/market-hub.service.ts apps/api/src/modules/market-hub/market-hub.service.spec.ts
git commit -m "feat(market-hub): watch open positions with real symbols and their underlyings at priority 1" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-tracker/services/trade-tracker.service.ts apps/api/src/modules/trade-tracker/services/trade-tracker.service.spec.ts apps/api/src/modules/market-hub/hub-engine.ts apps/api/src/modules/market-hub/hub-engine.spec.ts apps/api/src/modules/market-hub/market-hub.service.ts apps/api/src/modules/market-hub/market-hub.service.spec.ts
```

---

### Task 4: Tracker ticks keyed by exchange + token

**Files:**
- Modify: `apps/api/src/modules/trade-tracker/services/trade-tracker.service.ts` (`applyTick`, `flushTicks`)
- Modify: `apps/api/src/modules/trade-tracker/services/trade-tracker.service.spec.ts`
- Modify: `apps/api/src/modules/trade-tracker/services/trade-tracker-poller.service.ts` (`sweepQuotes` call sites and keys)
- Modify: `apps/api/src/modules/trade-tracker/services/trade-tracker-poller.service.spec.ts` (replaced in full)

**Interfaces:**
- Consumes: `computeTickPatch` (unchanged); `TokenRef` (`user-feed.types.ts`).
- Produces:

```typescript
export interface TickTarget { exchange: string; token: string }
// scope absent = legacy, market-wide (every holder); scope present = that user's trackers only (hub)
TradeTrackerService.applyTick(target: TickTarget, ltp: number, scope?: { userId: string }): void
TradeTrackerService.flushTicks(): Promise<void>   // a user's scoped price wins over the market-wide one
```

- [ ] **Step 1: Write the failing tests**

In `trade-tracker.service.spec.ts`, replace the whole `describe('applyTick / flushTicks', () => { … });` block with:

```typescript
  describe('applyTick / flushTicks', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const NSE_111 = { exchange: 'NSE', token: '111' };

    it('debounces: many calls within the window schedule ONE flush', async () => {
      const flushSpy = jest.spyOn(service, 'flushTicks').mockResolvedValue(undefined);

      service.applyTick(NSE_111, 100);
      service.applyTick(NSE_111, 101);
      service.applyTick({ exchange: 'NSE', token: '222' }, 200);
      expect(flushSpy).not.toHaveBeenCalled(); // still debouncing

      jest.advanceTimersByTime(3_000);
      expect(flushSpy).toHaveBeenCalledTimes(1);
    });

    it('ignores empty tokens, a missing exchange and non-positive ltp', async () => {
      const flushSpy = jest.spyOn(service, 'flushTicks').mockResolvedValue(undefined);
      service.applyTick({ exchange: 'NSE', token: '' }, 100);
      service.applyTick({ exchange: '', token: '111' }, 100);
      service.applyTick(NSE_111, 0);
      service.applyTick(NSE_111, -5);
      jest.advanceTimersByTime(3_000);
      expect(flushSpy).not.toHaveBeenCalled();
    });

    it('flushTicks writes the computed patch for every OPEN tracker on the exchange + token', async () => {
      prisma.tradeTracker.findMany.mockResolvedValue([
        tracker({ id: 'a', token: '111', exchange: 'NSE', entryPrice: 100, qty: 10, holdingHigh: 100, holdingLow: 100 }),
      ]);
      service.applyTick(NSE_111, 130);

      await service.flushTicks();

      expect(prisma.tradeTracker.findMany).toHaveBeenCalledWith({
        where: { status: 'OPEN', token: { in: ['111'] } },
      });
      const call = prisma.tradeTracker.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'a', userId: 'user_1' });
      expect(call.data).toMatchObject({
        holdingHigh: 130,
        lastLtp: 130,
        pnl: 300, // (130-100)*10
        pnlPercent: 30,
      });
    });

    it('keeps the same token on two exchanges apart', async () => {
      prisma.tradeTracker.findMany.mockResolvedValue([
        tracker({ id: 'cash', token: '500', exchange: 'NSE', entryPrice: 100, qty: 1 }),
        tracker({ id: 'commodity', token: '500', exchange: 'MCX', entryPrice: 7000, qty: 1 }),
      ]);
      service.applyTick({ exchange: 'NSE', token: '500' }, 130);
      await service.flushTicks();
      expect(prisma.tradeTracker.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.tradeTracker.updateMany.mock.calls[0][0].where).toEqual({ id: 'cash', userId: 'user_1' });
      expect(prisma.tradeTracker.updateMany.mock.calls[0][0].data).toMatchObject({ lastLtp: 130 });

      prisma.tradeTracker.updateMany.mockClear();
      service.applyTick({ exchange: 'MCX', token: '500' }, 7010);
      await service.flushTicks();
      expect(prisma.tradeTracker.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.tradeTracker.updateMany.mock.calls[0][0].where).toEqual({ id: 'commodity', userId: 'user_1' });
    });

    it('matches a lower-case exchange on the row', async () => {
      prisma.tradeTracker.findMany.mockResolvedValue([tracker({ id: 'opt', token: '35001', exchange: 'nfo' })]);
      service.applyTick({ exchange: 'NFO', token: '35001' }, 120);
      await service.flushTicks();
      expect(prisma.tradeTracker.updateMany.mock.calls[0][0].where).toEqual({ id: 'opt', userId: 'user_1' });
    });

    it('a user-scoped (hub) tick prices only that user; a market-wide (legacy) tick prices every holder; the scoped one wins for its user', async () => {
      prisma.tradeTracker.findMany.mockResolvedValue([
        tracker({ id: 'mine', userId: 'owner', token: '35001', exchange: 'NFO', entryPrice: 100, qty: 1 }),
        tracker({ id: 'theirs', userId: 'u2', token: '35001', exchange: 'NFO', entryPrice: 100, qty: 1 }),
      ]);
      service.applyTick({ exchange: 'NFO', token: '35001' }, 120, { userId: 'owner' });
      await service.flushTicks();
      expect(prisma.tradeTracker.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.tradeTracker.updateMany.mock.calls[0][0].where).toEqual({ id: 'mine', userId: 'owner' });

      prisma.tradeTracker.updateMany.mockClear();
      service.applyTick({ exchange: 'NFO', token: '35001' }, 118);
      service.applyTick({ exchange: 'NFO', token: '35001' }, 121, { userId: 'owner' });
      await service.flushTicks();
      const byId = new Map(
        prisma.tradeTracker.updateMany.mock.calls.map((c) => [c[0].where.id, c[0].data.lastLtp] as const),
      );
      expect(byId).toEqual(new Map([['mine', 121], ['theirs', 118]]));
    });

    it('flushTicks is a no-op when nothing is pending', async () => {
      await service.flushTicks();
      expect(prisma.tradeTracker.findMany).not.toHaveBeenCalled();
    });
  });
```

Replace `trade-tracker-poller.service.spec.ts` in full with:

```typescript
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import { TradeTrackerService } from './trade-tracker.service';
import { TradeTrackerPoller } from './trade-tracker-poller.service';

/** A socket quote the sweep should treat as live (stamped now). */
function liveQuote(ltp: number) {
  return { ltp, timestamp: new Date() };
}

/** A socket quote as stale as the KEI option's was — hours old, never evicted. */
function staleQuote(ltp: number) {
  return { ltp, timestamp: new Date(Date.now() - 21 * 60 * 60 * 1000) };
}

describe('TradeTrackerPoller', () => {
  let poller: TradeTrackerPoller;
  let prisma: { brokerCredential: { findMany: jest.Mock } };
  let feed: { subscribe: jest.Mock; getQuote: jest.Mock; isMarketOpen: jest.Mock };
  let userFeeds: { fetchQuotes: jest.Mock };
  let service: {
    backfill: jest.Mock;
    distinctOpenTokens: jest.Mock;
    openTrackerRefsByUser: jest.Mock;
    applyTick: jest.Mock;
  };

  beforeEach(async () => {
    prisma = { brokerCredential: { findMany: jest.fn().mockResolvedValue([]) } };
    feed = {
      subscribe: jest.fn().mockResolvedValue([]),
      getQuote: jest.fn().mockReturnValue(null),
      isMarketOpen: jest.fn().mockReturnValue(true),
    };
    userFeeds = { fetchQuotes: jest.fn().mockResolvedValue(new Map()) };
    service = {
      backfill: jest.fn().mockResolvedValue(undefined),
      distinctOpenTokens: jest.fn().mockResolvedValue([]),
      openTrackerRefsByUser: jest.fn().mockResolvedValue(new Map()),
      applyTick: jest.fn(),
    };

    const mod = await Test.createTestingModule({
      providers: [
        TradeTrackerPoller,
        { provide: PrismaService, useValue: prisma },
        { provide: MarketFeedService, useValue: feed },
        { provide: UserFeedManager, useValue: userFeeds },
        { provide: TradeTrackerService, useValue: service },
      ],
    }).compile();

    poller = mod.get(TradeTrackerPoller);
  });

  describe('reconcileAll', () => {
    it('backfills every credentialed user then subscribes all OPEN tokens', async () => {
      prisma.brokerCredential.findMany.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
      service.distinctOpenTokens.mockResolvedValue(['111', '222']);

      await poller.reconcileAll();

      expect(service.backfill).toHaveBeenCalledWith('u1');
      expect(service.backfill).toHaveBeenCalledWith('u2');
      expect(feed.subscribe).toHaveBeenCalledWith(['111', '222']);
    });

    it('one user failing does not abort the batch', async () => {
      prisma.brokerCredential.findMany.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
      service.backfill.mockRejectedValueOnce(new Error('broker down'));

      await poller.reconcileAll();

      expect(service.backfill).toHaveBeenCalledTimes(2);
    });

    it('no-ops with no credentialed users', async () => {
      prisma.brokerCredential.findMany.mockResolvedValue([]);
      await poller.reconcileAll();
      expect(service.backfill).not.toHaveBeenCalled();
      expect(feed.subscribe).not.toHaveBeenCalled();
    });
  });

  describe('sweepQuotes (legacy tiers)', () => {
    it('is idle when the market is closed', async () => {
      feed.isMarketOpen.mockReturnValue(false);
      await poller.sweepQuotes();
      expect(service.openTrackerRefsByUser).not.toHaveBeenCalled();
      expect(userFeeds.fetchQuotes).not.toHaveBeenCalled();
      expect(service.applyTick).not.toHaveBeenCalled();
    });

    it('applies a fresh socket quote without spending a broker call', async () => {
      service.openTrackerRefsByUser.mockResolvedValue(new Map([['u1', [{ token: '111', exchange: 'NSE' }]]]));
      feed.getQuote.mockReturnValue(liveQuote(105));

      await poller.sweepQuotes();

      expect(service.applyTick).toHaveBeenCalledWith({ token: '111', exchange: 'NSE' }, 105);
      expect(userFeeds.fetchQuotes).not.toHaveBeenCalled();
    });

    it('REST-fetches a token whose socket quote is hours old (the KEI failure)', async () => {
      service.openTrackerRefsByUser.mockResolvedValue(new Map([['u1', [{ token: 'KEI', exchange: 'NFO' }]]]));
      feed.getQuote.mockReturnValue(staleQuote(3.5));
      userFeeds.fetchQuotes.mockResolvedValue(new Map([['KEI', { ltp: 41.2 }]]));

      await poller.sweepQuotes();

      expect(userFeeds.fetchQuotes).toHaveBeenCalledWith('u1', [{ token: 'KEI', exchange: 'NFO' }]);
      expect(service.applyTick).toHaveBeenCalledWith({ token: 'KEI', exchange: 'NFO' }, 41.2);
      expect(service.applyTick).not.toHaveBeenCalledWith(expect.anything(), 3.5);
    });

    it('REST-fetches a token the socket pool never served at all', async () => {
      service.openTrackerRefsByUser.mockResolvedValue(new Map([['u1', [{ token: '999', exchange: 'NFO' }]]]));
      userFeeds.fetchQuotes.mockResolvedValue(new Map([['999', { ltp: 12 }]]));

      await poller.sweepQuotes();

      expect(service.applyTick).toHaveBeenCalledWith({ token: '999', exchange: 'NFO' }, 12);
    });

    it('issues exactly ONE batched call per user, carrying all that user’s tokens', async () => {
      service.openTrackerRefsByUser.mockResolvedValue(
        new Map([
          [
            'u1',
            [
              { token: '111', exchange: 'NFO' },
              { token: '222', exchange: 'NSE' },
              { token: '333', exchange: 'MCX' },
            ],
          ],
          ['u2', [{ token: '444', exchange: 'NSE' }]],
        ]),
      );
      userFeeds.fetchQuotes.mockImplementation((_userId: string, refs: Array<{ token: string }>) =>
        Promise.resolve(new Map(refs.map((r) => [r.token, { ltp: Number(r.token) }]))),
      );

      await poller.sweepQuotes();

      expect(userFeeds.fetchQuotes).toHaveBeenCalledTimes(2);
      expect(userFeeds.fetchQuotes).toHaveBeenCalledWith('u1', [
        { token: '111', exchange: 'NFO' },
        { token: '222', exchange: 'NSE' },
        { token: '333', exchange: 'MCX' },
      ]);
      expect(userFeeds.fetchQuotes).toHaveBeenCalledWith('u2', [{ token: '444', exchange: 'NSE' }]);
      expect(service.applyTick).toHaveBeenCalledTimes(4);
      expect(service.applyTick).toHaveBeenCalledWith({ token: '333', exchange: 'MCX' }, 333);
    });

    it('prices far more tokens than the 30-slot socket pool could carry', async () => {
      const refs = Array.from({ length: 50 }, (_, i) => ({ token: `t${i}`, exchange: 'NSE' }));
      service.openTrackerRefsByUser.mockResolvedValue(new Map([['u1', refs]]));
      userFeeds.fetchQuotes.mockResolvedValue(new Map(refs.map((r) => [r.token, { ltp: 7 }])));

      await poller.sweepQuotes();

      expect(userFeeds.fetchQuotes).toHaveBeenCalledTimes(1);
      expect(service.applyTick).toHaveBeenCalledTimes(50);
    });

    it('one user’s expired session does not stop the other users being priced', async () => {
      service.openTrackerRefsByUser.mockResolvedValue(
        new Map([
          ['u1', [{ token: '111', exchange: 'NSE' }]],
          ['u2', [{ token: '222', exchange: 'NSE' }]],
        ]),
      );
      userFeeds.fetchQuotes.mockImplementation((userId: string) =>
        userId === 'u1' ? Promise.reject(new Error('Invalid session')) : Promise.resolve(new Map([['222', { ltp: 99 }]])),
      );

      await poller.sweepQuotes();

      expect(userFeeds.fetchQuotes).toHaveBeenCalledTimes(2);
      expect(service.applyTick).toHaveBeenCalledTimes(1);
      expect(service.applyTick).toHaveBeenCalledWith({ token: '222', exchange: 'NSE' }, 99);
    });

    it('a shared instrument is quoted once, and a second holder can cover a failed session', async () => {
      service.openTrackerRefsByUser.mockResolvedValue(
        new Map([
          ['u1', [{ token: 'SHARED', exchange: 'NSE' }]],
          ['u2', [{ token: 'SHARED', exchange: 'NSE' }]],
          ['u3', [{ token: 'SHARED', exchange: 'NSE' }]],
        ]),
      );
      userFeeds.fetchQuotes.mockImplementation((userId: string) =>
        userId === 'u1' ? Promise.reject(new Error('Invalid session')) : Promise.resolve(new Map([['SHARED', { ltp: 55 }]])),
      );

      await poller.sweepQuotes();

      // u1 failed, u2 answered, u3 was never asked — the legacy price is market-wide.
      expect(userFeeds.fetchQuotes).toHaveBeenCalledTimes(2);
      expect(service.applyTick).toHaveBeenCalledTimes(1);
      expect(service.applyTick).toHaveBeenCalledWith({ token: 'SHARED', exchange: 'NSE' }, 55);
    });

    it('legacy: keeps the same token on two exchanges apart', async () => {
      // The socket cache and Angel's REST answer are both keyed by token alone.
      feed.getQuote.mockReturnValue(liveQuote(1));
      service.openTrackerRefsByUser.mockResolvedValue(
        new Map([
          ['u1', [{ token: '500', exchange: 'NSE' }]],
          ['u2', [{ token: '500', exchange: 'MCX' }]],
        ]),
      );
      userFeeds.fetchQuotes.mockImplementation((userId: string) =>
        Promise.resolve(new Map([['500', { ltp: userId === 'u1' ? 9 : 7000 }]])),
      );

      await poller.sweepQuotes();

      // The token-only socket cache cannot tell the two apart, so it is not read for them.
      expect(feed.getQuote).not.toHaveBeenCalled();
      expect(service.applyTick).toHaveBeenCalledWith({ token: '500', exchange: 'NSE' }, 9);
      expect(service.applyTick).toHaveBeenCalledWith({ token: '500', exchange: 'MCX' }, 7000);
      expect(service.applyTick).toHaveBeenCalledTimes(2);
    });

    it('legacy: a token-keyed REST answer is not guessed onto one of two exchanges', async () => {
      service.openTrackerRefsByUser.mockResolvedValue(
        new Map([['u1', [{ token: '500', exchange: 'NSE' }, { token: '500', exchange: 'MCX' }]]]),
      );
      userFeeds.fetchQuotes.mockResolvedValue(new Map([['500', { ltp: 9 }]]));

      await poller.sweepQuotes();

      expect(service.applyTick).not.toHaveBeenCalled();
    });

    it('ignores non-positive quotes from either tier', async () => {
      service.openTrackerRefsByUser.mockResolvedValue(
        new Map([
          [
            'u1',
            [
              { token: '111', exchange: 'NSE' },
              { token: '222', exchange: 'NSE' },
            ],
          ],
        ]),
      );
      feed.getQuote.mockImplementation((token: string) => (token === '111' ? liveQuote(0) : null));
      userFeeds.fetchQuotes.mockResolvedValue(
        new Map([
          ['111', { ltp: 0 }],
          ['222', { ltp: 0 }],
        ]),
      );

      await poller.sweepQuotes();

      expect(service.applyTick).not.toHaveBeenCalled();
    });

    it('no open trackers means no broker traffic', async () => {
      service.openTrackerRefsByUser.mockResolvedValue(new Map());
      await poller.sweepQuotes();
      expect(userFeeds.fetchQuotes).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @td/api test -- trade-tracker.service.spec trade-tracker-poller.service.spec`
Expected: FAIL. The tracker tests time out or find no update (`applyTick` still takes a token string, so the object key never matches). The poller assertions see `applyTick('111', 105)` instead of `({ token, exchange }, 105)`. The two "legacy: same token" tests apply the wrong price.

- [ ] **Step 3: Implement**

In `trade-tracker.service.ts`:
- add after `PositionRef`:

```typescript
/** Which instrument a tick prices. Tokens collide across exchanges, so both are required. */
export interface TickTarget {
  exchange: string;
  token: string;
}

interface PendingTick {
  /** null = legacy, market-wide (every holder); a userId = that user's trackers only (hub). */
  userId: string | null;
  exchange: string;
  token: string;
  ltp: number;
}

function tickKey(userId: string | null, exchange: string, token: string): string {
  return `${userId ?? '*'}|${exchange.toUpperCase()}:${token}`;
}
```

- change the field to `private readonly pendingTicks = new Map<string, PendingTick>();` and its comment to `/** Latest pending LTP per (scope, EXCHANGE:token), coalesced between debounced flushes. */`;
- replace `applyTick` and `flushTicks` (with their doc comments) with:

```typescript
  /**
   * Fold a price into OPEN trackers on `target` (exchange + token). Without a
   * scope the price is market-wide and reaches every holder (the legacy sweep's
   * contract). With `{ userId }` it reaches only that user's trackers: the hub
   * prices a user's positions from that user's own session and never anyone
   * else's. Writes are DEBOUNCED: the latest LTP per (scope, instrument) is
   * flushed in a batch every {@link TICK_DEBOUNCE_MS} (design §4.1).
   */
  applyTick(target: TickTarget, ltp: number, scope?: { userId: string }): void {
    if (!target?.token || !target.exchange || !(ltp > 0)) return;
    const userId = scope?.userId ?? null;
    const exchange = target.exchange.toUpperCase();
    this.pendingTicks.set(tickKey(userId, exchange, target.token), { userId, exchange, token: target.token, ltp });
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flushTicks();
      }, TICK_DEBOUNCE_MS);
    }
  }

  /**
   * Flush all coalesced ticks. Each OPEN tracker takes the price for its own
   * exchange + token: its user's scoped (hub) price if one is pending, else the
   * market-wide one. Exposed for the poller's shutdown drain and for tests.
   */
  async flushTicks(): Promise<void> {
    if (this.pendingTicks.size === 0) return;
    const batch = new Map(this.pendingTicks);
    this.pendingTicks.clear();

    const tokens = [...new Set([...batch.values()].map((t) => t.token))];
    const open = await this.prisma.tradeTracker.findMany({
      where: { status: 'OPEN', token: { in: tokens } },
    });
    if (open.length === 0) return;

    const now = new Date();
    for (const tracker of open) {
      const exchange = String(tracker.exchange ?? '').toUpperCase();
      const tick =
        batch.get(tickKey(tracker.userId, exchange, tracker.token)) ?? batch.get(tickKey(null, exchange, tracker.token));
      if (!tick) continue;
      const patch = computeTickPatch(tracker, tick.ltp, now);
      try {
        await this.prisma.tradeTracker.updateMany({
          where: { id: tracker.id, userId: tracker.userId },
          data: patch,
        });
      } catch (err) {
        this.logger.warn(
          `applyTick flush failed for tracker ${tracker.id}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
```

In `trade-tracker-poller.service.ts`:
- add `import type { TokenRef } from '../../market-data/services/user-feed.types';`;
- replace the body of `sweepQuotes` from `const byUser = await this.service.openTrackerRefsByUser();` up to (not including) `} finally {` with:

```typescript
      const byUser = await this.service.openTrackerRefsByUser();
      if (byUser.size === 0) return;

      // Instruments still needing a price, keyed EXCHANGE:token (tokens collide
      // across exchanges) and deduped across tenants.
      const unpriced = new Set<string>();
      const shared = tokensOnSeveralExchanges(byUser);
      let fromSocket = 0;
      for (const refs of byUser.values()) {
        for (const ref of refs) {
          const key = tickRefKey(ref);
          if (unpriced.has(key)) continue;
          // The shared socket cache is keyed by token alone: a token held on two
          // exchanges cannot be read from it without guessing the instrument.
          const quote = shared.has(ref.token) ? null : this.feed.getQuote(ref.token);
          if (quote && quote.ltp > 0 && this.isFresh(quote.timestamp)) {
            this.service.applyTick(ref, quote.ltp);
            fromSocket++;
          } else {
            unpriced.add(key);
          }
        }
      }

      let fromRest = 0;
      let failedUsers = 0;
      for (const [userId, refs] of byUser) {
        const wanted = refs.filter((r) => unpriced.has(tickRefKey(r)));
        if (wanted.length === 0) continue;

        try {
          const quotes = await this.userFeeds.fetchQuotes(userId, wanted);
          for (const [token, tick] of quotes) {
            if (!tick || !(tick.ltp > 0)) continue;
            // Angel answers keyed by token alone: attribute it only when this user
            // asked for that token on exactly one exchange.
            const asked = wanted.filter((r) => r.token === token);
            if (asked.length !== 1) continue;
            this.service.applyTick(asked[0], tick.ltp);
            // Priced — no later user is asked for it again this pass.
            unpriced.delete(tickRefKey(asked[0]));
            fromRest++;
          }
        } catch (err) {
          failedUsers++;
          // Leave this user's instruments in `unpriced`: another tenant holding the
          // same instrument later in the loop can still answer for it.
          this.logger.warn(
            `[trade-tracker] batched quote fetch failed for a user: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      if (unpriced.size > 0) {
        // Not noise: an instrument nobody could quote is a tracker whose LTP is now ageing.
        this.logger.warn(
          `[trade-tracker] ${unpriced.size} open token(s) went unpriced this sweep ` +
            `(socket=${fromSocket}, rest=${fromRest}, failed users=${failedUsers})`,
        );
      } else {
        this.logger.debug(
          `[trade-tracker] swept ${fromSocket + fromRest} token(s) (socket=${fromSocket}, rest=${fromRest})`,
        );
      }
```

- append at the end of the file (after the class):

```typescript
/** EXCHANGE:token — the tracker's instrument key (tokens collide across exchanges). */
function tickRefKey(ref: TokenRef): string {
  return `${String(ref.exchange ?? '').toUpperCase()}:${ref.token}`;
}

/** Tokens that open trackers hold on more than one exchange (unsafe for token-keyed caches). */
function tokensOnSeveralExchanges(byUser: Map<string, TokenRef[]>): Set<string> {
  const exchanges = new Map<string, Set<string>>();
  for (const refs of byUser.values()) {
    for (const r of refs) {
      const set = exchanges.get(r.token) ?? new Set<string>();
      set.add(String(r.exchange ?? '').toUpperCase());
      exchanges.set(r.token, set);
    }
  }
  return new Set([...exchanges].filter(([, set]) => set.size > 1).map(([token]) => token));
}
```

- in the class doc comment of `sweepQuotes`, replace the sentence ``The PRICE it returns, though, is market-wide: `applyTick` deliberately updates every user's trackers on that token`` with ``The PRICE it returns, though, is market-wide: an unscoped `applyTick` deliberately updates every user's trackers on that exchange + token``.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @td/api test -- trade-tracker.service.spec trade-tracker-poller.service.spec`
Expected: PASS.
Run: `pnpm --filter @td/api test -- trade-tracker trade-sentinel`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-tracker/services/trade-tracker.service.ts apps/api/src/modules/trade-tracker/services/trade-tracker.service.spec.ts apps/api/src/modules/trade-tracker/services/trade-tracker-poller.service.ts apps/api/src/modules/trade-tracker/services/trade-tracker-poller.service.spec.ts
git commit -m "fix(trade-tracker): key ticks by exchange + token and allow user-scoped prices" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-tracker/services/trade-tracker.service.ts apps/api/src/modules/trade-tracker/services/trade-tracker.service.spec.ts apps/api/src/modules/trade-tracker/services/trade-tracker-poller.service.ts apps/api/src/modules/trade-tracker/services/trade-tracker-poller.service.spec.ts
```

---

### Task 5: Tracker hub tier: tick listener + sweep (HUB_PRICES_POSITIONS)

**Files:**
- Modify: `apps/api/src/modules/trade-tracker/services/trade-tracker-poller.service.ts`
- Modify: `apps/api/src/modules/trade-tracker/services/trade-tracker-poller.service.spec.ts`

**Interfaces:**
- Consumes: `HUB_PRICE_SOURCE`, `lookupHubPrices`, `HubPriceSource`, `engineHubPrices` (Task 1); `applyTick(target, ltp, { userId })` (Task 4); `isHubExchange`, `refKey`, `Price`, `InstrumentRef` (`hub.types.ts`).
- Produces:
  - `TradeTrackerPoller` constructor `(prisma, feed, userFeeds, service, moduleRef: ModuleRef)`; `implements OnModuleDestroy`.
  - Sweep tier 0: the hub for users `hubFor(userId, 'positions')` serves, fresh ≤ 5 000 ms → `applyTick(…, { userId })`; otherwise the legacy tiers.
  - Hub tick listener, subscribed once: every hub price for an instrument in the served user's open set → `applyTick(…, { userId })`.
  - Counters: `record('positions', 'hub' | 'legacy' | 'unpriced', n)` once per sweep.

- [ ] **Step 1: Write the failing tests**

In `trade-tracker-poller.service.spec.ts`, add these imports at the top:

```typescript
import { HubEngine } from '../../market-hub/hub-engine';
import { HUB_PRICE_SOURCE, engineHubPrices } from '../../market-hub/hub-prices';
import { SessionClock } from '../../market-hub/session-clock';
import { FakeBroker } from '../../market-hub/testing/fake-broker';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
```

and append at the end of the file:

```typescript
describe('TradeTrackerPoller — hub tier (HUB_PRICES_POSITIONS)', () => {
  const IST = (local: string) => Date.parse(`${local}+05:30`);
  const OPT = { token: '35001', exchange: 'NFO' };
  let poller: TradeTrackerPoller;
  let engine: HubEngine;
  let broker: FakeBroker;
  let feed: { subscribe: jest.Mock; getQuote: jest.Mock; isMarketOpen: jest.Mock };
  let userFeeds: { fetchQuotes: jest.Mock };
  let service: { backfill: jest.Mock; distinctOpenTokens: jest.Mock; openTrackerRefsByUser: jest.Mock; applyTick: jest.Mock };
  let record: jest.Mock;
  /** Users the hub serves: stands in for MarketHubService.hubFor (owner + flag on). */
  let serves: Set<string>;

  beforeEach(async () => {
    record = jest.fn();
    serves = new Set(['owner']);
    const source = {
      hubFor: jest.fn((userId: string | null) => (userId !== null && serves.has(userId) ? engineHubPrices(engine) : null)),
      record,
    };
    feed = { subscribe: jest.fn(), getQuote: jest.fn().mockReturnValue(null), isMarketOpen: jest.fn().mockReturnValue(true) };
    userFeeds = { fetchQuotes: jest.fn().mockResolvedValue(new Map()) };
    service = {
      backfill: jest.fn(),
      distinctOpenTokens: jest.fn(),
      openTrackerRefsByUser: jest.fn().mockResolvedValue(new Map([['owner', [OPT]]])),
      applyTick: jest.fn(),
    };
    const mod = await Test.createTestingModule({
      providers: [
        TradeTrackerPoller,
        { provide: PrismaService, useValue: { brokerCredential: { findMany: jest.fn() } } },
        { provide: MarketFeedService, useValue: feed },
        { provide: UserFeedManager, useValue: userFeeds },
        { provide: TradeTrackerService, useValue: service },
        { provide: HUB_PRICE_SOURCE, useValue: source },
      ],
    }).compile();
    poller = mod.get(TradeTrackerPoller);

    jest.useFakeTimers();
    jest.setSystemTime(IST('2026-10-07T10:00:00')); // Wednesday, NSE/NFO/MCX open
    broker = new FakeBroker();
    engine = new HubEngine({ broker, clock: new SessionClock({ holidays: MARKET_HOLIDAYS }), cap: 50, defaults: [] });
    await engine.start();
    broker.emitState('live'); // socket up: no critical-lane polling in these tests
    await engine.setPositions([{ exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' }]);
  });

  afterEach(() => {
    poller.onModuleDestroy();
    engine.stop();
    jest.useRealTimers();
  });

  it('prices the owner’s position from a fresh hub price, scoped to the owner, with no broker call', async () => {
    broker.emitTick(FakeBroker.tick('35001', 250.5, 'NFO'));

    await poller.sweepQuotes();

    expect(service.applyTick).toHaveBeenCalledTimes(1);
    expect(service.applyTick).toHaveBeenCalledWith({ exchange: 'NFO', token: '35001' }, 250.5, { userId: 'owner' });
    expect(userFeeds.fetchQuotes).not.toHaveBeenCalled();
    expect(feed.getQuote).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith('positions', 'hub', 1);
    expect(record).toHaveBeenCalledWith('positions', 'unpriced', 0);
  });

  it('between sweeps, every hub price for an owned position reaches applyTick (the ≤ 5 s path), subscribed once', async () => {
    await poller.sweepQuotes(); // learns the owned set and subscribes
    await poller.sweepQuotes(); // must not subscribe a second listener
    service.applyTick.mockClear();

    broker.emitTick(FakeBroker.tick('35001', 251, 'NFO'));

    expect(service.applyTick).toHaveBeenCalledTimes(1);
    expect(service.applyTick).toHaveBeenCalledWith({ exchange: 'NFO', token: '35001' }, 251, { userId: 'owner' });
  });

  it('a never-priced or stale hub answer falls back to the legacy tiers over the owner’s own session', async () => {
    userFeeds.fetchQuotes.mockResolvedValue(new Map([['35001', { ltp: 41.2 }]]));

    await poller.sweepQuotes(); // the hub has never priced it yet

    expect(userFeeds.fetchQuotes).toHaveBeenCalledWith('owner', [OPT]);
    expect(service.applyTick).toHaveBeenCalledWith(OPT, 41.2);
    expect(record).toHaveBeenCalledWith('positions', 'legacy', 1);

    broker.emitTick(FakeBroker.tick('35001', 250.5, 'NFO'));
    service.applyTick.mockClear();
    userFeeds.fetchQuotes.mockClear();
    jest.setSystemTime(Date.now() + 6000); // older than the 5 s bound

    await poller.sweepQuotes();

    expect(service.applyTick).not.toHaveBeenCalledWith(expect.anything(), 250.5, expect.anything());
    expect(userFeeds.fetchQuotes).toHaveBeenCalledWith('owner', [OPT]);
  });

  it('never prices a non-owner’s tracker from the owner’s hub', async () => {
    service.openTrackerRefsByUser.mockResolvedValue(new Map([['owner', [OPT]], ['u2', [OPT]]]));
    userFeeds.fetchQuotes.mockResolvedValue(new Map([['35001', { ltp: 249 }]]));
    broker.emitTick(FakeBroker.tick('35001', 250.5, 'NFO'));

    await poller.sweepQuotes();

    expect(service.applyTick).toHaveBeenCalledWith({ exchange: 'NFO', token: '35001' }, 250.5, { userId: 'owner' });
    // u2 is priced over u2's OWN session (legacy), never by the owner's hub.
    expect(userFeeds.fetchQuotes).toHaveBeenCalledTimes(1);
    expect(userFeeds.fetchQuotes).toHaveBeenCalledWith('u2', [OPT]);
    expect(service.applyTick).toHaveBeenCalledWith(OPT, 249);

    broker.emitTick(FakeBroker.tick('35001', 252, 'NFO'));
    const scopes = service.applyTick.mock.calls.map((c) => (c[2] as { userId: string } | undefined)?.userId ?? null);
    expect(scopes).not.toContain('u2');
    expect(service.applyTick).toHaveBeenLastCalledWith({ exchange: 'NFO', token: '35001' }, 252, { userId: 'owner' });
  });

  it('same token on two exchanges: the hub prices each instrument separately', async () => {
    const MCX = { token: '35001', exchange: 'MCX' };
    await engine.setPositions([
      { exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' },
      { exchange: 'MCX', token: '35001', symbol: 'CRUDEOIL26OCTFUT' },
    ]);
    service.openTrackerRefsByUser.mockResolvedValue(new Map([['owner', [OPT, MCX]]]));
    userFeeds.fetchQuotes.mockResolvedValue(new Map([['35001', { ltp: 41.2 }]]));
    broker.emitTick(FakeBroker.tick('35001', 6400, 'MCX'));

    await poller.sweepQuotes();

    expect(service.applyTick).toHaveBeenCalledWith({ exchange: 'MCX', token: '35001' }, 6400, { userId: 'owner' });
    expect(service.applyTick).not.toHaveBeenCalledWith({ exchange: 'NFO', token: '35001' }, 6400, expect.anything());
    // The NFO contract was not hub-priced, so it went to REST alone: its answer is unambiguous.
    expect(userFeeds.fetchQuotes).toHaveBeenCalledWith('owner', [OPT]);
    expect(service.applyTick).toHaveBeenCalledWith(OPT, 41.2);
    expect(feed.getQuote).not.toHaveBeenCalled();
  });

  it('with no hub for the user (flag off or hub not running) the sweep is exactly the legacy path', async () => {
    serves.clear();
    broker.emitTick(FakeBroker.tick('35001', 250.5, 'NFO'));
    userFeeds.fetchQuotes.mockResolvedValue(new Map([['35001', { ltp: 41.2 }]]));

    await poller.sweepQuotes();

    expect(service.applyTick).toHaveBeenCalledTimes(1);
    expect(service.applyTick).toHaveBeenCalledWith(OPT, 41.2);
    broker.emitTick(FakeBroker.tick('35001', 251, 'NFO'));
    expect(service.applyTick).toHaveBeenCalledTimes(1); // no listener was ever attached
  });

  it('stops applying hub ticks once the position is no longer open', async () => {
    await poller.sweepQuotes();
    service.openTrackerRefsByUser.mockResolvedValue(new Map());
    await poller.sweepQuotes();
    service.applyTick.mockClear();

    broker.emitTick(FakeBroker.tick('35001', 251, 'NFO'));

    expect(service.applyTick).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @td/api test -- trade-tracker-poller.service.spec`
Expected: FAIL. The hub tests see `fetchQuotes` called (no hub tier yet) and `poller.onModuleDestroy is not a function`. The legacy describe still passes.

- [ ] **Step 3: Implement**

In `trade-tracker-poller.service.ts`:
- change the imports to:

```typescript
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Cron, Interval } from '@nestjs/schedule';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import type { TokenRef } from '../../market-data/services/user-feed.types';
import { lookupHubPrices, type HubPriceSource } from '../../market-hub/hub-prices';
import { isHubExchange, refKey, type InstrumentRef, type Price } from '../../market-hub/hub.types';
import { TradeTrackerService, type TickTarget } from './trade-tracker.service';
```

- change the class declaration to `export class TradeTrackerPoller implements OnModuleDestroy {`;
- add after `WS_FRESH_MS`:

```typescript
  /** Spec §2 / §5.3: an open position's price is at most 5 s old (Position Manager maxAge). */
  private static readonly HUB_MAX_AGE_MS = 5000;

  /** The hub-served user's open instruments (EXCHANGE:token), rebuilt every sweep; read by the tick listener. */
  private hubOwned = new Map<string, TickTarget>();
  private hubUserId: string | null = null;
  private unsubscribeHub: (() => void) | null = null;
  private hubSourceRef: HubPriceSource | null = null;
```

- add `private readonly moduleRef: ModuleRef,` as the last constructor parameter;
- add after the constructor:

```typescript
  onModuleDestroy(): void {
    this.unsubscribeHub?.();
    this.unsubscribeHub = null;
  }
```

- in `sweepQuotes`, replace the two lines

```typescript
      const byUser = await this.service.openTrackerRefsByUser();
      if (byUser.size === 0) return;
```

with

```typescript
      const byUser = await this.service.openTrackerRefsByUser();
      const source = this.hubSource();
      // Tier 0 first, and always: it also rebuilds (or empties) the set the hub
      // tick listener prices between sweeps.
      const served = this.priceFromHub(byUser, source);
      if (byUser.size === 0) return;
```

- in the socket loop, change `for (const refs of byUser.values()) {` to `for (const [userId, refs] of byUser) {` and `if (unpriced.has(key)) continue;` to `if (served.has(`${userId}|${key}`) || unpriced.has(key)) continue;`;
- in the REST loop, change `const wanted = refs.filter((r) => unpriced.has(tickRefKey(r)));` to

```typescript
        const wanted = refs.filter((r) => {
          const key = tickRefKey(r);
          return unpriced.has(key) && !served.has(`${userId}|${key}`);
        });
```

- replace the closing `if (unpriced.size > 0) { … } else { … }` block with:

```typescript
      source?.record('positions', 'hub', served.size);
      source?.record('positions', 'legacy', fromSocket + fromRest);
      source?.record('positions', 'unpriced', unpriced.size);

      if (unpriced.size > 0) {
        // Not noise: an instrument nobody could quote is a tracker whose LTP is now ageing.
        this.logger.warn(
          `[trade-tracker] ${unpriced.size} open token(s) went unpriced this sweep ` +
            `(hub=${served.size}, socket=${fromSocket}, rest=${fromRest}, failed users=${failedUsers})`,
        );
      } else {
        this.logger.debug(
          `[trade-tracker] swept ${served.size + fromSocket + fromRest} token(s) ` +
            `(hub=${served.size}, socket=${fromSocket}, rest=${fromRest})`,
        );
      }
```

- add these private methods to the class (before `isFresh`):

```typescript
  /**
   * Tier 0 (HUB_PRICES_POSITIONS): the hub, for the users it serves (today the
   * owner only, see HubPriceSource.hubFor). A fresh (≤ 5 s) price is applied
   * scoped to that user; anything else falls through to the legacy tiers.
   * Returns `${userId}|EXCHANGE:token` for every instrument served here.
   */
  private priceFromHub(byUser: Map<string, TokenRef[]>, source: HubPriceSource | null): Set<string> {
    const served = new Set<string>();
    const owned = new Map<string, TickTarget>();
    let owner: string | null = null;
    for (const [userId, refs] of byUser) {
      const hub = source?.hubFor(userId, 'positions') ?? null;
      if (!hub) continue;
      if (!this.unsubscribeHub) this.unsubscribeHub = hub.onPrice((p) => this.onHubPrice(p));
      owner = userId;
      const hubRefs = refs.map(toHubRef).filter((r): r is InstrumentRef => r !== null);
      const results = hub.prices(hubRefs, { maxAgeMs: TradeTrackerPoller.HUB_MAX_AGE_MS });
      for (const ref of hubRefs) {
        const key = refKey(ref);
        const target: TickTarget = { exchange: ref.exchange, token: ref.token };
        owned.set(key, target);
        const r = results.get(key);
        if (r?.kind !== 'fresh') continue;
        this.service.applyTick(target, r.price.ltp, { userId });
        served.add(`${userId}|${key}`);
      }
    }
    this.hubOwned = owned;
    this.hubUserId = owner;
    return served;
  }

  /** Every hub price (tick or polled quote) for an instrument the served user holds, as it arrives. */
  private onHubPrice(p: Price): void {
    const userId = this.hubUserId;
    const target = this.hubOwned.get(refKey(p.ref));
    if (!userId || !target || !(p.ltp > 0)) return;
    this.service.applyTick(target, p.ltp, { userId });
  }

  /** Resolved lazily (MarketHubModule imports this module); a miss is retried next sweep. */
  private hubSource(): HubPriceSource | null {
    if (!this.hubSourceRef) this.hubSourceRef = lookupHubPrices(this.moduleRef);
    return this.hubSourceRef;
  }
```

- append after `tokensOnSeveralExchanges` at the end of the file:

```typescript
/** The hub's ref for a tracker instrument, or null for an exchange the hub does not speak. */
function toHubRef(ref: TokenRef): InstrumentRef | null {
  const exchange = String(ref.exchange ?? '').toUpperCase();
  return isHubExchange(exchange) && ref.token ? { exchange, token: ref.token, symbol: ref.token } : null;
}
```

- in the `sweepQuotes` doc comment, add a tier above the two existing ones:
  ` *  0. HUB (HUB_PRICES_POSITIONS) — for the user the hub serves (the owner), a price ≤ 5 s old, scoped to that user. Between sweeps the hub tick listener applies every new price as it arrives; this sweep is the safety net.`

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @td/api test -- trade-tracker-poller.service.spec`
Expected: PASS (legacy describe unchanged, hub describe 7 tests).
Run: `pnpm --filter @td/api test -- trade-tracker market-hub`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-tracker/services/trade-tracker-poller.service.ts apps/api/src/modules/trade-tracker/services/trade-tracker-poller.service.spec.ts
git commit -m "feat(trade-tracker): price the owner's positions from the hub as ticks arrive, sweep as safety net" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-tracker/services/trade-tracker-poller.service.ts apps/api/src/modules/trade-tracker/services/trade-tracker-poller.service.spec.ts
```

---

### Task 6: Sentinel tick source: contract price + underlying spot via the hub

**Files:**
- Modify: `apps/api/src/modules/trade-sentinel/adapters/tick-source.adapter.ts`
- Modify: `apps/api/src/modules/trade-sentinel/adapters/tick-source.adapter.spec.ts`
- Modify: `apps/api/src/modules/trade-sentinel/services/context-packet.service.ts` (`SPOT_SOURCE_HUB`)

**Interfaces:**
- Consumes: `lookupHubPrices`, `HubPriceSource`, `HubPrices` (Task 1); `resolveUnderlying` (Task 2); `getInstrumentByToken(token, exchange)` (Task 2); `isHubExchange`, `InstrumentRef` (`hub.types.ts`).
- Produces:
  - `export const HUB_DECISION_MAX_AGE_MS = 10_000;` (`tick-source.adapter.ts`)
  - `export const SPOT_SOURCE_HUB: string;` (`context-packet.service.ts`)
  - `SentinelTickSource` constructor gains `@Optional() moduleRef?: ModuleRef` as its 7th parameter.
  - Contract `ltp`: the hub's fresh price when `hubFor(row.userId, 'positions')` serves; otherwise the stored `lastLtp` with the existing refusals.
  - Underlying spot tiers: hub (P1) → level book → per-user quote on the **resolved underlying's exchange**.

- [ ] **Step 1: Write the failing tests**

In `tick-source.adapter.spec.ts`:
- add imports:

```typescript
import type { HubPriceSource, HubPrices } from '../../market-hub/hub-prices';
import type { HubExchange, InstrumentRef, PriceResult } from '../../market-hub/hub.types';
import { SPOT_SOURCE_HUB } from '../services/context-packet.service';
```

- change `function make(opts: { withFeed?: boolean } = {}) {` to `function make(opts: { withFeed?: boolean; hub?: HubPriceSource } = {}) {`, and in `make`, change the constructor call's last argument line `userFeed,` to:

```typescript
    userFeed,
    opts.hub ? ({ get: jest.fn(() => opts.hub) } as never) : undefined,
```

- add after `make`:

```typescript
/** A hub that serves `owner` with fixed answers per EXCHANGE:token. */
function hubWith(answers: Record<string, PriceResult>, owner = 'u1') {
  const record = jest.fn();
  const hub: HubPrices = {
    price: jest.fn(
      (ref: InstrumentRef): PriceResult => answers[`${ref.exchange}:${ref.token}`] ?? { kind: 'unavailable', reason: 'not-watched' },
    ),
    prices: jest.fn(),
    watch: jest.fn().mockResolvedValue(undefined),
    onPrice: jest.fn(() => () => undefined),
  };
  const source: HubPriceSource = { hubFor: jest.fn((userId: string | null) => (userId === owner ? hub : null)), record };
  return { hub, source, record };
}

const freshAt = (exchange: HubExchange, token: string, ltp: number, at: number): PriceResult => ({
  kind: 'fresh',
  price: { ref: { exchange, token, symbol: token }, ltp, at, source: 'ws' },
});
```

- inside `describe('derivatives', …)`, add next to `option`:

```typescript
    const stockOption = () => row({ symbol: 'KEI29SEP265800CE', exchange: 'NFO', token: '77', lastLtp: 40 });
```

- in the test "resolves the underlying ONCE and uses the same one for spot, levels and news" AND in the test "takes the underlying spot from the live level book", replace `expect(t.getLevels).toHaveBeenCalledWith('26000');` with `expect(t.getLevels).toHaveBeenCalledWith('99926000');` (both occurrences: NIFTY is an index, its spot is keyed by the index token);
- in the test "quotes the underlying when it is not on the live feed", replace

```typescript
        // The CASH token on NSE — not the derivative's own token or exchange,
        // which the broker would resolve to nothing.
        expect(t.fetchQuote).toHaveBeenCalledWith('u1', '26000', 'NSE');
```

with

```typescript
        // The INDEX token on its own exchange — not the derivative's own token
        // or exchange, which the broker would resolve to nothing.
        expect(t.fetchQuote).toHaveBeenCalledWith('u1', '99926000', 'NSE');
```

- replace the whole test "keeps the level book and the news when only the SPOT cannot be resolved" with:

```typescript
    it('keeps the level book and the news when only the SPOT cannot be resolved', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const t = make();
      t.findUnique.mockResolvedValue(stockOption());
      t.getInstrumentByToken.mockResolvedValue({ name: 'KEI', expiry: null });
      // The NAME resolved; no NSE cash row (KEI-EQ, then KEI) did.
      t.getInstrumentBySymbol.mockResolvedValue(null);

      const tick = await t.svc.tickFor('t1');

      // Only the spot needs the token. Collapsing the two would take the level
      // book and the news down with it for no reason.
      expect(tick.underlyingLtp).toBeNull();
      expect(t.getInstrumentBySymbol).toHaveBeenCalledWith('KEI-EQ', 'NSE');
      expect(t.getInstrumentBySymbol).toHaveBeenCalledWith('KEI', 'NSE');
      expect(t.structureFor).toHaveBeenCalledWith('KEI', null, 'u1');
      expect(t.getNewsForSymbol).toHaveBeenCalledWith('KEI');
    });
```

- replace the whole test "memoises a SUCCESSFUL resolution — the master does not change intraday" with:

```typescript
    it('memoises a SUCCESSFUL resolution — the master does not change intraday', async () => {
      const t = make();
      t.findUnique.mockResolvedValue(stockOption());
      t.getInstrumentByToken.mockResolvedValue({ name: 'KEI', expiry: null });
      t.getInstrumentBySymbol.mockResolvedValue({ token: '13310', symbol: 'KEI-EQ' });
      t.getLevels.mockReturnValue({ spot: 4100, lastTickAt: NOW });

      await t.svc.tickFor('t1');
      const after = t.getInstrumentBySymbol.mock.calls.length;
      await t.svc.tickFor('t1');

      expect(after).toBe(1);
      expect(t.getInstrumentBySymbol.mock.calls.length).toBe(after);
      expect(t.getLevels).toHaveBeenCalledWith('13310');
    });
```

- append inside `describe('derivatives', …)`:

```typescript
    it('looks the contract up WITH its exchange — tokens collide across segments', async () => {
      const t = make();
      t.findUnique.mockResolvedValue(option());
      t.getInstrumentByToken.mockResolvedValue({ name: 'NIFTY', expiry: null });

      await t.svc.tickFor('t1');

      expect(t.getInstrumentByToken).toHaveBeenCalledWith('99', 'NFO');
      expect(t.getInstrumentByToken.mock.calls.every((c) => c[1] === 'NFO')).toBe(true);
    });

    it('resolves an index option to the index token, with no cash lookup at all', async () => {
      const t = make();
      t.findUnique.mockResolvedValue(option());
      t.getInstrumentByToken.mockResolvedValue({ name: 'NIFTY', expiry: null });
      t.getLevels.mockReturnValue({ spot: 24010, lastTickAt: NOW });

      const tick = await t.svc.tickFor('t1');

      expect(tick.underlyingLtp).toBe(24010);
      expect(t.getLevels).toHaveBeenCalledWith('99926000');
      expect(t.getInstrumentBySymbol).not.toHaveBeenCalled();
    });

    it('quotes a SENSEX option’s underlying on BSE, not a hard-coded NSE', async () => {
      const t = make();
      t.findUnique.mockResolvedValue(row({ symbol: 'SENSEX26OCT81000CE', exchange: 'BFO', token: '880', lastLtp: 300 }));
      t.getInstrumentByToken.mockResolvedValue({ name: 'SENSEX', expiry: null });
      t.fetchQuote.mockResolvedValue({ ltp: 81050 });

      const tick = await t.svc.tickFor('t1');

      expect(t.fetchQuote).toHaveBeenCalledWith('u1', '99919000', 'BSE');
      expect(tick.underlyingLtp).toBe(81050);
    });

    it('quotes a stock option’s underlying on NSE by its -EQ cash row', async () => {
      const t = make();
      t.findUnique.mockResolvedValue(stockOption());
      t.getInstrumentByToken.mockResolvedValue({ name: 'KEI', expiry: null });
      t.getInstrumentBySymbol.mockImplementation(async (symbol: string) => (symbol === 'KEI-EQ' ? { token: '13310', symbol } : null));
      t.fetchQuote.mockResolvedValue({ ltp: 4100 });

      const tick = await t.svc.tickFor('t1');

      expect(t.fetchQuote).toHaveBeenCalledWith('u1', '13310', 'NSE');
      expect(tick.underlyingLtp).toBe(4100);
    });

    describe('the hub tier (HUB_PRICES_POSITIONS)', () => {
      it('prices the contract from a fresh hub price, even when the tracker row is stale', async () => {
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const { source, record } = hubWith({ 'NFO:99': freshAt('NFO', '99', 131, NOW.getTime() - 500) });
        const t = make({ hub: source });
        t.findUnique.mockResolvedValue({ ...option(), updatedAt: new Date(NOW.getTime() - 10 * 60_000) });

        const tick = await t.svc.tickFor('t1');

        expect(tick.ltp).toBe(131);
        expect(record).toHaveBeenCalledWith('positions', 'hub');
      });

      it('falls back to the tracker row when the hub has never priced it', async () => {
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const { source, record } = hubWith({ 'NFO:99': { kind: 'unavailable', reason: 'never-priced' } });
        const t = make({ hub: source });
        t.findUnique.mockResolvedValue(option());

        const tick = await t.svc.tickFor('t1');

        expect(tick.ltp).toBe(120);
        expect(record).toHaveBeenCalledWith('positions', 'legacy');
      });

      it('a stale hub price and a stale row still refuse to judge, and count as unpriced', async () => {
        const { source, record } = hubWith({
          'NFO:99': { kind: 'stale', ageMs: 60_000, price: { ref: { exchange: 'NFO', token: '99', symbol: '99' }, ltp: 118, at: NOW.getTime() - 60_000, source: 'ws' } },
        });
        const t = make({ hub: source });
        t.findUnique.mockResolvedValue({ ...option(), updatedAt: new Date(NOW.getTime() - LTP_STALENESS_MS - 1) });

        await expect(t.svc.tickFor('t1')).rejects.toThrow(/REFUSING to judge/i);
        expect(record).toHaveBeenCalledWith('positions', 'unpriced');
      });

      it('a non-owner’s position never reads the owner’s hub', async () => {
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const { hub, source } = hubWith({ 'NFO:99': freshAt('NFO', '99', 131, NOW.getTime()) }, 'owner');
        const t = make({ hub: source });
        t.findUnique.mockResolvedValue(option()); // userId 'u1', not the hub's owner

        const tick = await t.svc.tickFor('t1');

        expect(tick.ltp).toBe(120);
        expect(hub.price).not.toHaveBeenCalled();
      });

      it('takes an index option’s spot from the hub at priority 1', async () => {
        const { source } = hubWith({
          'NFO:99': freshAt('NFO', '99', 121, NOW.getTime()),
          'NSE:99926000': freshAt('NSE', '99926000', 24010, NOW.getTime() - 800),
        });
        const t = make({ hub: source });
        t.findUnique.mockResolvedValue(option());
        t.getInstrumentByToken.mockResolvedValue({ name: 'NIFTY', expiry: null });

        const tick = await t.svc.tickFor('t1');

        expect(tick.underlyingLtp).toBe(24010);
        expect(tick.underlyingLtpSource).toBe(SPOT_SOURCE_HUB);
        // The hub's receipt time, not the packet's build time.
        expect(tick.underlyingLtpAt).toBe(new Date(NOW.getTime() - 800).toISOString());
        expect(t.getInstrumentBySymbol).not.toHaveBeenCalled();
        expect(t.getLevels).not.toHaveBeenCalled();
        expect(t.fetchQuote).not.toHaveBeenCalled();
      });

      it('a hub spot that is not fresh falls through to the level book and then the quote', async () => {
        const { source } = hubWith({ 'NSE:99926000': { kind: 'unavailable', reason: 'never-priced' } });
        const t = make({ hub: source });
        t.findUnique.mockResolvedValue(option());
        t.getInstrumentByToken.mockResolvedValue({ name: 'NIFTY', expiry: null });
        t.fetchQuote.mockResolvedValue({ ltp: 24005 });

        const tick = await t.svc.tickFor('t1');

        expect(t.getLevels).toHaveBeenCalledWith('99926000');
        expect(t.fetchQuote).toHaveBeenCalledWith('u1', '99926000', 'NSE');
        expect(tick.underlyingLtp).toBe(24005);
        expect(tick.underlyingLtpSource).toMatch(/quote/i);
      });
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @td/api test -- tick-source.adapter.spec`
Expected: FAIL. `SPOT_SOURCE_HUB` is undefined. `getLevels` is called with `null`, because NIFTY has no cash row in the mocks. The KEI tests see `getInstrumentBySymbol('KEI', 'NSE')` asked first. The SENSEX quote goes to `'NSE'` and comes back null. The hub tests read `lastLtp` (ltp 120) or throw on the stale row.

- [ ] **Step 3: Implement**

In `context-packet.service.ts`, append after `SPOT_SOURCE_QUOTE` (and change the comment's "The three ways" to "The four ways"):

```typescript
export const SPOT_SOURCE_HUB = 'market-hub (underlying spot — hub price: live tick or critical-lane quote, ≤ 10 s old)';
```

In `tick-source.adapter.ts`:
- change/add imports:

```typescript
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { lookupHubPrices, type HubPriceSource, type HubPrices } from '../../market-hub/hub-prices';
import { isHubExchange, type InstrumentRef } from '../../market-hub/hub.types';
import { resolveUnderlying as resolveUnderlyingRef } from '../../market-hub/underlying';
```

and add `SPOT_SOURCE_HUB,` to the existing `../services/context-packet.service` import list;
- add after `LTP_STALENESS_MS`:

```typescript
/**
 * SP1 M3: the hub's price is used for a judgement only if it is at most this old
 * (spec §5.3, "trading decisions 10 s"). Older, and the existing tiers decide.
 */
export const HUB_DECISION_MAX_AGE_MS = 10_000;
```

- change `interface Underlying` to add the exchange, and `NO_UNDERLYING` with it:

```typescript
interface Underlying {
  name: string | null;
  token: string | null;
  /** The exchange `token` belongs to (NSE for NIFTY and stocks, BSE for SENSEX). */
  exchange: string | null;
}

const NO_UNDERLYING: Underlying = { name: null, token: null, exchange: null };
```

- add after `istDateOnly`:

```typescript
/** The hub's ref for an instrument, or null for an exchange the hub does not speak. */
function toHubRef(exchange: string | null | undefined, token: string, symbol: string): InstrumentRef | null {
  const ex = String(exchange ?? '').toUpperCase();
  return isHubExchange(ex) && token ? { exchange: ex, token, symbol } : null;
}
```

- add the field `private hubSourceRef: HubPriceSource | null = null;` after `quotes`;
- add `@Optional() private readonly moduleRef?: ModuleRef,` as the last constructor parameter, with the comment `// SP1 M3: HUB_PRICE_SOURCE, resolved lazily (MarketHubModule is not imported here). Absent ⇒ no hub tier.`;
- in `tickFor`, replace everything from the comment `// No price means no judgement.` down to and including the closing `}` of the `if (ageMs > LTP_STALENESS_MS) { … }` block with:

```typescript
    // SP1 M3 (HUB_PRICES_POSITIONS): the hub's own price for the contract when it
    // serves this user (today: the owner only) and has one ≤ 10 s old. Otherwise
    // the tracker row, with both of its refusals.
    const source = this.hubSource();
    const hub = source?.hubFor(row.userId, 'positions') ?? null;
    const hubLtp = this.hubContractPrice(hub, row);
    let ltp: number;
    if (hubLtp !== null) {
      ltp = hubLtp;
      source?.record('positions', 'hub');
    } else {
      try {
        ltp = this.storedPrice(trackerId, row);
      } catch (err) {
        source?.record('positions', 'unpriced');
        throw err;
      }
      source?.record('positions', 'legacy');
    }
```

- in `tickFor`, change
  `const underlying = isCash ? NO_UNDERLYING : await this.resolveUnderlying(row.token, row.symbol);` to
  `const underlying = isCash ? NO_UNDERLYING : await this.resolveUnderlying(row.exchange, row.token, row.symbol);`,
  change `: await this.spotFor(underlying.token, row.userId, row.symbol);` to
  `: await this.spotFor(underlying, row.userId, row.symbol, hub);`,
  and change `expiry: await this.expiryFor(row.token, segment),` to
  `expiry: await this.expiryFor(row.token, row.exchange, segment),`;
- add these private methods (after `tickFor`):

```typescript
  /** The hub's fresh contract price, or null (no hub for this user, an exchange it does not speak, or not fresh). */
  private hubContractPrice(hub: HubPrices | null, row: { exchange: string; token: string; symbol: string }): number | null {
    const ref = hub ? toHubRef(row.exchange, row.token, row.symbol) : null;
    if (!hub || !ref) return null;
    const r = hub.price(ref, { maxAgeMs: HUB_DECISION_MAX_AGE_MS });
    return r.kind === 'fresh' && r.price.ltp > 0 ? r.price.ltp : null;
  }

  /**
   * The tracker row's price, refusing a missing or stale one (see LTP_STALENESS_MS).
   * Substituting the entry price would report a moving trade as flat.
   */
  private storedPrice(trackerId: string, row: { symbol: string; lastLtp: number | null; updatedAt: Date }): number {
    const ltp = row.lastLtp;
    if (ltp === null || !Number.isFinite(ltp)) {
      throw new TickUnavailable(
        `no live price on tracker ${trackerId} (${row.symbol}) — the tracker poller has not ` +
          'ticked it yet, or the feed is down',
      );
    }
    const ageMs = Date.now() - row.updatedAt.getTime();
    if (ageMs > LTP_STALENESS_MS) {
      throw new TickUnavailable(
        `the price on tracker ${trackerId} (${row.symbol}) is ${Math.round(ageMs / 60_000)} ` +
          `minutes old (last ${ltp} at ${row.updatedAt.toISOString()}), past the ` +
          `${LTP_STALENESS_MS / 60_000}-minute bound. Its token is almost certainly not ` +
          'subscribed to the feed — the primary slot pool is small and the default universe ' +
          'claims it at boot. REFUSING to judge: P&L, the green floor and every tripwire ' +
          'would be computed from a stale price and reported as the market now.',
      );
    }
    return ltp;
  }

  /** Resolved lazily; a miss (no hub in this container) is retried on the next tick. */
  private hubSource(): HubPriceSource | null {
    if (!this.hubSourceRef) this.hubSourceRef = lookupHubPrices(this.moduleRef);
    return this.hubSourceRef;
  }
```

- replace the signature and the first two statements of `spotFor` (keep its doc comment, and add to the THE TIERS list a tier `0. the hub (HUB_PRICES_POSITIONS): the underlying is watched at priority 1 beside the position, so its price is a live tick or a critical-lane quote ≤ 10 s old;`) with:

```typescript
  private async spotFor(
    underlying: Underlying,
    userId: string,
    symbol: string,
    hub: HubPrices | null,
  ): Promise<SpotReading> {
    const underlyingToken = underlying.token;
    if (!underlyingToken) return NO_SPOT;

    // Tier 0 — the hub. A stale or missing hub price falls THROUGH, never returns.
    const hubRef = hub ? toHubRef(underlying.exchange, underlyingToken, underlying.name ?? underlyingToken) : null;
    if (hub && hubRef) {
      const r = hub.price(hubRef, { maxAgeMs: HUB_DECISION_MAX_AGE_MS });
      if (r.kind === 'fresh' && r.price.ltp > 0) {
        return { ltp: r.price.ltp, at: new Date(r.price.at).toISOString(), source: SPOT_SOURCE_HUB, reason: null };
      }
    }
```

  The rest of `spotFor` is unchanged except the tier-2 call, which becomes
  `const quoted = await this.quoteFor(underlyingToken, underlying.exchange ?? 'NSE', userId, symbol);`;
- replace `quoteFor` (keep its doc comment) with:

```typescript
  private async quoteFor(
    token: string,
    exchange: string,
    userId: string,
    symbol: string,
  ): Promise<SpotReading | null> {
    if (!this.userFeed) return null;

    const key = `${exchange}:${token}`;
    const cached = this.quotes.get(key);
    if (cached && Date.now() - cached.at < SPOT_QUOTE_TTL_MS) {
      // The CAPTURE time of the original quote, not this cache hit.
      return { ltp: cached.ltp, at: cached.capturedAt, source: SPOT_SOURCE_QUOTE, reason: null };
    }

    try {
      // The UNDERLYING's own exchange (NSE for NIFTY and stocks, BSE for SENSEX),
      // never the derivative's (NFO/BFO/MCX), or the broker resolves nothing.
      const tick = await this.userFeed.fetchQuote(userId, token, exchange);
      const ltp = tick?.ltp;
      if (!Number.isFinite(ltp as number) || (ltp as number) <= 0) return null;

      const capturedAt = new Date().toISOString();
      this.quotes.set(key, { at: Date.now(), ltp: ltp as number, capturedAt });
      return { ltp: ltp as number, at: capturedAt, source: SPOT_SOURCE_QUOTE, reason: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `underlying quote failed for ${symbol} (token ${token}): ${message} — the spot, the ` +
          'nearest levels and the OI walls will all be absent for this tick',
      );
      return null;
    }
  }
```

- replace `resolveUnderlying` (keep its doc comment, adding `Index underlyings come from market-hub/underlying.ts's one map: index rows are not in the instrument table.`) with:

```typescript
  private async resolveUnderlying(exchange: string, token: string, symbol: string): Promise<Underlying> {
    const key = `${String(exchange ?? '').toUpperCase()}:${token}`;
    const cached = this.underlyings.get(key);
    if (cached) return cached;

    let resolved: Underlying = NO_UNDERLYING;
    try {
      const r = await resolveUnderlyingRef(
        { exchange: exchange ?? '', token, symbol },
        {
          contract: (ex, tok) => this.instruments.getInstrumentByToken(tok, ex || undefined),
          cash: (sym, ex) => this.instruments.getInstrumentBySymbol(sym, ex),
        },
      );
      if (r.name) {
        resolved = { name: normaliseSymbol(r.name), token: r.ref?.token ?? null, exchange: r.ref?.exchange ?? null };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`could not resolve the underlying for ${symbol}: ${message}`);
      return NO_UNDERLYING;
    }

    if (resolved.name === null) {
      this.warnOnce(
        key,
        `no underlying name on the instrument master for ${symbol} — its level book, its news ` +
          'and its OI walls are all unavailable, so the level, volume and news sensors will ' +
          'stay silent on this position for as long as it is held',
      );
    } else if (resolved.token === null) {
      this.warnOnce(
        key,
        `resolved ${symbol} to underlying ${resolved.name}, but no cash/index instrument for it ` +
          '— the level book and news still work, the underlying SPOT does not, so the level ' +
          'and OI sensors stay silent',
      );
    }
    this.underlyings.set(key, resolved);
    return resolved;
  }
```

- replace `expiryFor` with:

```typescript
  /** The nearest expiry as 'YYYY-MM-DD', or null for cash (the OI capture key). */
  private async expiryFor(token: string, exchange: string, segment: Segment): Promise<string | null> {
    if (segment !== 'OPT' && segment !== 'FUT') return null;
    try {
      const contract = await this.instruments.getInstrumentByToken(token, String(exchange ?? '').toUpperCase() || undefined);
      const expiry = contract?.expiry;
      if (!expiry) return null;
      return istDateOnly(expiry);
    } catch {
      // A missing expiry means no OI capture for this position — which the
      // snapshot service already treats as a stated absence.
      return null;
    }
  }
```

- update the class note's second KNOWN GAPS bullet to read: `underlyingLtp for a derivative comes from the hub (when HUB_PRICES_POSITIONS serves this user), else the live level book, else a broker quote on the underlying's own exchange. When all three are empty it is null, and levelBreak and the OI capture both correctly stay silent.`

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @td/api test -- tick-source.adapter.spec`
Expected: PASS (all tests: the edited existing ones, the four new derivative tests and the six hub tests).
Run: `pnpm --filter @td/api test -- trade-sentinel`
Expected: PASS. This includes `sentinel-cycle.service.spec`, whose import-graph isolation property does not reach the adapter.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-sentinel/adapters/tick-source.adapter.ts apps/api/src/modules/trade-sentinel/adapters/tick-source.adapter.spec.ts apps/api/src/modules/trade-sentinel/services/context-packet.service.ts
git commit -m "feat(trade-sentinel): contract price and underlying spot from the hub; index underlyings resolved" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/trade-sentinel/adapters/tick-source.adapter.ts apps/api/src/modules/trade-sentinel/adapters/tick-source.adapter.spec.ts apps/api/src/modules/trade-sentinel/services/context-packet.service.ts
```

---

### Task 7: ExitPriceService hub tier with watch and TTL (HUB_PRICES_TRACKS)

**Files:**
- Modify: `apps/api/src/modules/signal-generator/services/exit-price.service.ts` (replaced in full)
- Modify: `apps/api/src/modules/signal-generator/services/exit-price.service.spec.ts`

**Interfaces:**
- Consumes: `lookupHubPrices`, `HubPriceSource`, `engineHubPrices` (Task 1); `HubEngine.watchMany` (Task 1); `isHubExchange`, `refKey` (`hub.types.ts`).
- Produces:

```typescript
export type ExitPriceSource = 'hub' | 'rest-batch' | 'rest-single' | 'levelbook';
export interface ExitPrice { price: number; fresh: boolean; source: ExitPriceSource | 'none' }   // shape unchanged
export const EXIT_WATCH_OWNER = 'track:exit';
/** Paper track exits are demotable (3): real open positions (0) keep the live slots; near-live polling (~5 s) meets the 10 s bound. */
export const EXIT_WATCH_PRIORITY = 3;
export const EXIT_WATCH_TTL_MS = 120_000;
export const EXIT_HUB_MAX_AGE_MS = 10_000;
// constructor(adapter, levelBook, @Optional() moduleRef?: ModuleRef)
// resolveExitPrices(exchange, tokens, symbolByToken?) — signature unchanged; one entry per input token, in input order
```

- [ ] **Step 1: Write the failing tests**

In `exit-price.service.spec.ts`, change the first import line to
`import { EXIT_WATCH_OWNER, ExitPriceService } from './exit-price.service';`, add these imports below it:

```typescript
import { HubEngine } from '../../market-hub/hub-engine';
import { engineHubPrices, type HubPriceSource } from '../../market-hub/hub-prices';
import { SessionClock } from '../../market-hub/session-clock';
import { FakeBroker } from '../../market-hub/testing/fake-broker';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
```

and append at the end of the file:

```typescript
describe('ExitPriceService — hub tier (HUB_PRICES_TRACKS)', () => {
  const IST = (local: string) => Date.parse(`${local}+05:30`);
  let engine: HubEngine;
  let broker: FakeBroker;
  let adapter: { getLtpsBatch: jest.Mock; getLiveQuote: jest.Mock };
  let levelBook: { getLevels: jest.Mock };
  let record: jest.Mock;
  let tracksOn: boolean;
  let source: HubPriceSource;

  const make = (moduleRef: unknown = { get: jest.fn(() => source) }) =>
    new ExitPriceService(adapter as unknown as AngelOneAdapterService, levelBook as unknown as LevelBookService, moduleRef as never);

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(IST('2026-10-07T10:00:00'));
    broker = new FakeBroker();
    engine = new HubEngine({ broker, clock: new SessionClock({ holidays: MARKET_HOLIDAYS }), cap: 50, defaults: [] });
    await engine.start();
    broker.emitState('live'); // socket up: prices only arrive when a test emits them
    adapter = {
      getLtpsBatch: jest.fn().mockResolvedValue(new Map()),
      getLiveQuote: jest.fn().mockRejectedValue(new Error('Not authenticated (no feed account)')),
    };
    levelBook = { getLevels: jest.fn().mockReturnValue(null) };
    record = jest.fn();
    tracksOn = true;
    source = {
      hubFor: jest.fn((userId: string | null, consumer: string) =>
        tracksOn && userId === null && consumer === 'tracks' ? engineHubPrices(engine) : null,
      ),
      record,
    };
  });

  afterEach(() => {
    engine.stop();
    jest.useRealTimers();
  });

  it('a never-priced ref is watched at priority 3 and falls back to the legacy tiers — never a hub price of 0', async () => {
    adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 2501]]));
    const svc = make();

    const out = await svc.resolveExitPrices('NSE', ['2885'], new Map([['2885', 'RELIANCE']]));
    await jest.advanceTimersByTimeAsync(0);

    expect(out.get('2885')).toEqual({ price: 2501, fresh: true, source: 'rest-batch' });
    expect(adapter.getLtpsBatch).toHaveBeenCalledWith('NSE', ['2885']);
    const entry = engine.registry.entries().find((e) => e.ref.token === '2885');
    expect(entry).toMatchObject({ priority: 3, ref: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE' } });
    expect(broker.subscribed.has('NSE:2885')).toBe(true);
    expect(record).toHaveBeenCalledWith('tracks', 'legacy', 1);
    expect(record).toHaveBeenCalledWith('tracks', 'hub', 0);
  });

  it('serves a fresh hub price with source hub and spends no legacy call on it', async () => {
    const svc = make();
    await svc.resolveExitPrices('NSE', ['2885']);
    await jest.advanceTimersByTimeAsync(0);
    broker.emitTick(FakeBroker.tick('2885', 2510, 'NSE'));
    adapter.getLtpsBatch.mockClear();

    const out = await svc.resolveExitPrices('NSE', ['2885']);

    expect(out.get('2885')).toEqual({ price: 2510, fresh: true, source: 'hub' });
    expect(adapter.getLtpsBatch).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith('tracks', 'hub', 1);
  });

  it('asks the legacy batch only for the tokens the hub could not serve, and keeps input order', async () => {
    const svc = make();
    await svc.resolveExitPrices('NSE', ['2885', '1594']);
    await jest.advanceTimersByTimeAsync(0);
    broker.emitTick(FakeBroker.tick('2885', 2510, 'NSE'));
    adapter.getLtpsBatch.mockReset().mockResolvedValue(new Map([['1594', 1490]]));

    const out = await svc.resolveExitPrices('NSE', ['1594', '2885']);

    expect(adapter.getLtpsBatch).toHaveBeenCalledWith('NSE', ['1594']);
    expect([...out.keys()]).toEqual(['1594', '2885']);
    expect(out.get('1594')).toEqual({ price: 1490, fresh: true, source: 'rest-batch' });
    expect(out.get('2885')).toEqual({ price: 2510, fresh: true, source: 'hub' });
  });

  it('at 15:25 a hub price older than 10 s is not fresh; with no legacy price the answer is none', async () => {
    jest.setSystemTime(IST('2026-10-07T15:25:00'));
    const svc = make();
    await svc.resolveExitPrices('NSE', ['2885']);
    await jest.advanceTimersByTimeAsync(0);
    broker.emitTick(FakeBroker.tick('2885', 2510, 'NSE'));
    jest.setSystemTime(Date.now() + 11_000);

    const out = await svc.resolveExitPrices('NSE', ['2885']);

    expect(out.get('2885')).toEqual({ price: 0, fresh: false, source: 'none' });
    expect(adapter.getLiveQuote).toHaveBeenCalledWith('2885', 'NSE');
    expect(record).toHaveBeenCalledWith('tracks', 'unpriced', 1);
  });

  it('the watch expires 2 min after the last call, and every call renews it', async () => {
    const svc = make();
    const t0 = Date.now();
    await svc.resolveExitPrices('NSE', ['2885']);
    jest.setSystemTime(t0 + 90_000);
    await svc.resolveExitPrices('NSE', ['2885']); // renews until t0 + 210 s
    jest.setSystemTime(t0 + 150_000);
    await jest.advanceTimersByTimeAsync(30_000); // maintenance runs at ≤ t0 + 180 s
    expect(engine.registry.has('NSE:2885')).toBe(true);

    jest.setSystemTime(t0 + 210_001);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(engine.registry.has('NSE:2885')).toBe(false);
    expect(EXIT_WATCH_OWNER).toBe('track:exit');
  });

  it('takes the legacy path untouched when the tracks flag is off, the hub is absent, or the lookup throws', async () => {
    adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 2501]]));
    tracksOn = false;
    const flagOff = await make().resolveExitPrices('NSE', ['2885']);
    const noHub = await new ExitPriceService(adapter as unknown as AngelOneAdapterService, levelBook as unknown as LevelBookService).resolveExitPrices('NSE', ['2885']);
    const throws = await make({ get: jest.fn(() => { throw new Error('Nest could not find HUB_PRICE_SOURCE'); }) }).resolveExitPrices('NSE', ['2885']);

    for (const out of [flagOff, noHub, throws]) {
      expect(out.get('2885')).toEqual({ price: 2501, fresh: true, source: 'rest-batch' });
    }
    expect(engine.registry.size()).toBe(0); // nothing was watched
  });

  it('an exchange the hub does not speak (CDS) stays on the legacy path', async () => {
    adapter.getLtpsBatch.mockResolvedValue(new Map([['1', 83.2]]));

    const out = await make().resolveExitPrices('CDS', ['1']);

    expect(out.get('1')).toEqual({ price: 83.2, fresh: true, source: 'rest-batch' });
    expect(engine.registry.size()).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @td/api test -- exit-price.service.spec`
Expected: FAIL. `EXIT_WATCH_OWNER` is undefined; nothing is watched (`entry` undefined); the second call returns `source: 'rest-batch'`/`'none'` instead of `'hub'`. The six legacy tests still pass.

- [ ] **Step 3: Implement**

Replace `exit-price.service.ts` with:

```typescript
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { lookupHubPrices, type HubPriceSource } from '../../market-hub/hub-prices';
import { isHubExchange, refKey, type InstrumentRef } from '../../market-hub/hub.types';
import { LevelBookService } from './level-book.service';

export type ExitPriceSource = 'hub' | 'rest-batch' | 'rest-single' | 'levelbook';

export interface ExitPrice {
  price: number;
  fresh: boolean;
  source: ExitPriceSource | 'none';
}

/** Hub watch owner for strategy-track exits (system paper tracks, no userId). */
export const EXIT_WATCH_OWNER = 'track:exit';
/** Paper track exits are demotable (3): real open positions (0) keep the live slots; near-live polling (~5 s) meets the 10 s bound. */
export const EXIT_WATCH_PRIORITY = 3;
/** Renewed on every resolve: a track that stops asking stops holding a slot within 2 min. */
export const EXIT_WATCH_TTL_MS = 120_000;
/** Spec §5.3: trading decisions accept a price at most 10 s old. */
export const EXIT_HUB_MAX_AGE_MS = 10_000;

/**
 * Risk-critical exit pricing resolver. Exit pollers historically called
 * `getLtpsBatch` and SILENTLY skipped any token the batch omitted — a held
 * position could blow past its stop and never exit because we never saw a
 * price for it.
 *
 * This service implements a "fresh-or-surface" policy: get a FRESH price
 * when possible; never fire a stop on a stale price; surface (do NOT silently
 * drop) when no fresh price exists so the caller can decide what to do.
 *
 * SP1 M3 (HUB_PRICES_TRACKS): the market hub is tier 0. Every token is watched
 * at priority 3 (owner `track:exit`, 2 min TTL renewed per call) and read with a
 * 10 s bound; anything the hub cannot serve fresh falls through to the legacy
 * tiers for that token. With the flag off or no hub, behaviour is exactly M2's.
 */
@Injectable()
export class ExitPriceService {
  private readonly logger = new Logger(ExitPriceService.name);

  /** A level-book price counts as fresh only if its last tick is within this window. */
  private static readonly FRESH_WINDOW_MS = 120_000; // 2 min

  private hubSourceRef: HubPriceSource | null = null;

  constructor(
    private readonly adapter: AngelOneAdapterService,
    private readonly levelBook: LevelBookService,
    // Resolves HUB_PRICE_SOURCE lazily: MarketHubModule imports MarketDataModule,
    // which this @Global module imports too. Optional: a hand-built instance has no hub tier.
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  /**
   * Resolve an exit price per token with the fresh-or-surface policy:
   *  0. The hub (HUB_PRICES_TRACKS), a price ≤ 10 s old -> fresh, source 'hub'.
   *  1. REST batch (getLtpsBatch) -> fresh.
   *  2. For tokens the batch dropped: per-token getLiveQuote (REST) -> fresh if ltp>0.
   *  3. Still missing: level-book `spot` ONLY if the book's lastTickAt is within
   *     FRESH_WINDOW_MS and spot>0 (NEVER a vwap/prevClose-only seed) -> fresh.
   *  4. Otherwise { price: 0, fresh: false, source: 'none' } — caller must
   *     SURFACE, not fire a stop.
   *
   * Returns an entry for EVERY input token, in input order. `symbolByToken`
   * names the hub watch (the token is used when it is absent).
   */
  async resolveExitPrices(
    exchange: string,
    tokens: string[],
    symbolByToken?: Map<string, string>,
  ): Promise<Map<string, ExitPrice>> {
    const out = new Map<string, ExitPrice>();
    const uniq = [...new Set(tokens)];
    if (uniq.length === 0) return out;

    const source = this.hubSource();
    const resolved = new Map<string, ExitPrice>();
    const legacy = this.fromHub(source, exchange, uniq, symbolByToken, resolved);

    if (legacy.length > 0) {
      // Tier 1: REST batch.
      const batch = await this.adapter.getLtpsBatch(exchange, legacy);
      for (const token of legacy) {
        const ltp = batch.get(token);
        // Tiers 2 + 3 for everything the batch dropped.
        resolved.set(
          token,
          ltp != null && ltp > 0 ? { price: ltp, fresh: true, source: 'rest-batch' } : await this.resolveMissing(exchange, token),
        );
      }
    }

    for (const token of uniq) out.set(token, resolved.get(token) as ExitPrice);
    this.count(source, out);
    return out;
  }

  /** Tier 0. Fills `resolved` with fresh hub prices and returns the tokens left for the legacy tiers. */
  private fromHub(
    source: HubPriceSource | null,
    exchange: string,
    tokens: string[],
    symbolByToken: Map<string, string> | undefined,
    resolved: Map<string, ExitPrice>,
  ): string[] {
    const hub = source?.hubFor(null, 'tracks') ?? null;
    const ex = exchange.toUpperCase();
    if (!hub || !isHubExchange(ex)) return tokens;

    const refs: InstrumentRef[] = tokens.map((token) => ({ exchange: ex, token, symbol: symbolByToken?.get(token) ?? token }));
    // Register or renew, fire-and-forget: a slow broker subscribe must never hold an exit decision.
    void hub.watch(refs, EXIT_WATCH_PRIORITY, EXIT_WATCH_OWNER, EXIT_WATCH_TTL_MS).catch(() => undefined);
    const results = hub.prices(refs, { maxAgeMs: EXIT_HUB_MAX_AGE_MS });
    const legacy: string[] = [];
    for (const ref of refs) {
      const r = results.get(refKey(ref));
      if (r?.kind === 'fresh' && r.price.ltp > 0) {
        resolved.set(ref.token, { price: r.price.ltp, fresh: true, source: 'hub' });
      } else {
        // stale, market-closed, never-priced, not-watched, throttled, no-session: never a price of 0 from here.
        legacy.push(ref.token);
      }
    }
    return legacy;
  }

  /** /healthz/detail → hub.consumers.tracks. */
  private count(source: HubPriceSource | null, out: Map<string, ExitPrice>): void {
    if (!source) return;
    let hub = 0;
    let legacy = 0;
    let unpriced = 0;
    for (const r of out.values()) {
      if (!r.fresh) unpriced++;
      else if (r.source === 'hub') hub++;
      else legacy++;
    }
    source.record('tracks', 'hub', hub);
    source.record('tracks', 'legacy', legacy);
    source.record('tracks', 'unpriced', unpriced);
  }

  /** Resolved lazily; a miss (no hub in this container) is retried on the next call. */
  private hubSource(): HubPriceSource | null {
    if (!this.hubSourceRef) this.hubSourceRef = lookupHubPrices(this.moduleRef);
    return this.hubSourceRef;
  }

  private async resolveMissing(exchange: string, token: string): Promise<ExitPrice> {
    // Tier 2: per-token REST FULL quote (throws if nothing).
    try {
      const quote = await this.adapter.getLiveQuote(token, exchange);
      const ltp = Number(quote?.ltp ?? 0);
      if (ltp > 0) {
        return { price: ltp, fresh: true, source: 'rest-single' };
      }
    } catch (err) {
      this.logger.debug(
        `getLiveQuote(${token}) failed, trying level book: ${err instanceof Error ? err.message : err}`,
      );
    }

    // Tier 3: cached level-book spot, fresh ONLY if last tick is recent.
    const book = this.levelBook.getLevels(token);
    if (book && book.spot > 0) {
      const age = Date.now() - new Date(book.lastTickAt).getTime();
      if (age <= ExitPriceService.FRESH_WINDOW_MS) {
        return { price: book.spot, fresh: true, source: 'levelbook' };
      }
    }

    // Tier 4: surface — no fresh price. Caller must NOT fire a stop on this.
    return { price: 0, fresh: false, source: 'none' };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass, including the architecture ratchet**

Run: `pnpm --filter @td/api test -- exit-price.service.spec only-door.spec`
Expected: PASS (6 legacy + 7 hub tests; `only-door` unchanged: `getLtpsBatch`/`getLiveQuote` are not in its regex, and no new file calls the broker).
Run: `pnpm --filter @td/api test -- signal-generator watch-monitor adaptive-stop ungated sell-futures anand`
Expected: PASS (every caller mocks `ExitPriceService` or builds it with two arguments).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/signal-generator/services/exit-price.service.ts apps/api/src/modules/signal-generator/services/exit-price.service.spec.ts
git commit -m "feat(signal-generator): ExitPriceService reads the hub first behind HUB_PRICES_TRACKS" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/signal-generator/services/exit-price.service.ts apps/api/src/modules/signal-generator/services/exit-price.service.spec.ts
```

---

### Task 8: Breakout-swing and EOD square-offs through ExitPriceService

**Files:**
- Modify: `apps/api/src/modules/adaptive-stop-track/services/adaptive-stop-tick-poller.service.ts` + `.spec.ts`
- Modify: `apps/api/src/modules/ungated-track/services/ungated-tick-poller.service.ts` + `.spec.ts`
- Modify: `apps/api/src/modules/anand-dual-track/services/anand-price-monitor.service.ts`, `anand-dual-track/services/__tests__/anand-price-monitor.service.spec.ts`
- Modify: `apps/api/src/modules/sell-futures-track/services/sell-futures.service.ts` + `.spec.ts`
- Modify: `apps/api/src/modules/breakout-swing-track/services/breakout-swing-poller.service.ts` + `.spec.ts`

**Interfaces:**
- Consumes: `ExitPriceService.resolveExitPrices(exchange, tokens)` and `type ExitPrice` (Task 7; `@Global` `SignalGeneratorModule` exports it, so no module changes).
- Produces: no new API. Price-source changes:
  - `AdaptiveStopTickPoller` and `UngatedTickPoller` lose their `AngelOneAdapterService` constructor parameter (now unused). Their `eodSquareOff` exit price = fresh `ExitPrice.price` ?? `currentPrice` ?? `executedPrice` ?? 0.
  - `AnandPriceMonitorService.expireIntradayAtClose`: fresh price ?? `entryPrice` (constructor unchanged: `getHistoricalData` still uses the adapter).
  - `SellFuturesService` gains `exitPrice: ExitPriceService` as its 6th constructor parameter. `squareOffOpenPositions`: fresh price keyed `EXCHANGE:token` ?? `currentPrice` ?? `executedPrice` ?? 0.
  - `BreakoutSwingPollerService` constructor becomes `(repo, exitPrice: ExitPriceService)`. QUEUED fills and TRADED management use only fresh prices.

- [ ] **Step 1: Write the failing tests**

Append to `adaptive-stop-tick-poller.service.spec.ts`:

```typescript
describe('AdaptiveStopTickPoller.eodSquareOff', () => {
  let poller: AdaptiveStopTickPoller;
  let adapter: { getLtpsBatch: jest.Mock };
  let repo: { findAllActive: jest.Mock; update: jest.Mock };
  let exec: { closeTrade: jest.Mock };
  let exitPrice: { resolveExitPrices: jest.Mock };

  beforeEach(async () => {
    adapter = { getLtpsBatch: jest.fn().mockResolvedValue(new Map([['2885', 1]])) }; // must never be asked
    repo = {
      findAllActive: jest.fn().mockResolvedValue([
        { id: 'e1', status: 'TRADED', token: '2885', exchange: 'NSE', symbol: 'RELIANCE', paperTradeId: 'p1', currentPrice: 2490, executedPrice: 2500 },
      ]),
      update: jest.fn().mockResolvedValue(undefined),
    };
    exec = { closeTrade: jest.fn().mockResolvedValue(undefined) };
    exitPrice = { resolveExitPrices: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        AdaptiveStopTickPoller,
        { provide: AngelOneAdapterService, useValue: adapter },
        { provide: AdaptiveStopWatchRepository, useValue: repo },
        { provide: AdaptiveStopWatchService, useValue: { onTick: jest.fn() } },
        { provide: AdaptiveStopTradeExecutionService, useValue: exec },
        { provide: ExitPriceService, useValue: exitPrice },
      ],
    }).compile();
    poller = mod.get(AdaptiveStopTickPoller);
  });

  it('closes at the fresh price ExitPriceService resolved, never asking the shared adapter', async () => {
    exitPrice.resolveExitPrices.mockResolvedValue(new Map([['2885', { price: 2512, fresh: true, source: 'hub' }]]));

    const res = await poller.eodSquareOff();

    expect(exitPrice.resolveExitPrices).toHaveBeenCalledWith('NSE', ['2885']);
    expect(adapter.getLtpsBatch).not.toHaveBeenCalled();
    expect(exec.closeTrade).toHaveBeenCalledWith('p1', { reason: 'eod-square-off', exitPrice: 2512 });
    expect(res).toEqual({ attempted: 1, closed: 1, skipped: 0, errors: 0 });
  });

  it('with no fresh price it closes at the last known price, not at 0', async () => {
    exitPrice.resolveExitPrices.mockResolvedValue(new Map([['2885', { price: 0, fresh: false, source: 'none' }]]));

    await poller.eodSquareOff();

    expect(exec.closeTrade).toHaveBeenCalledWith('p1', { reason: 'eod-square-off', exitPrice: 2490 });
  });

  it('a failing resolver still squares off at the last known price', async () => {
    exitPrice.resolveExitPrices.mockRejectedValue(new Error('broker down'));

    await poller.eodSquareOff();

    expect(exec.closeTrade).toHaveBeenCalledWith('p1', { reason: 'eod-square-off', exitPrice: 2490 });
    expect(repo.update).toHaveBeenCalledWith('e1', expect.objectContaining({ closedReason: 'eod-square-off' }));
  });
});
```

Append to `ungated-tick-poller.service.spec.ts`:

```typescript
describe('UngatedTickPoller.eodSquareOff (15:25 IST)', () => {
  let poller: UngatedTickPoller;
  let adapter: { getLtpsBatch: jest.Mock };
  let repo: { findAllActive: jest.Mock; update: jest.Mock };
  let exec: { closeTrade: jest.Mock };
  let exitPrice: { resolveExitPrices: jest.Mock };

  beforeEach(async () => {
    adapter = { getLtpsBatch: jest.fn().mockResolvedValue(new Map([['1594', 1]])) }; // must never be asked
    repo = {
      findAllActive: jest.fn().mockResolvedValue([
        { id: 'u1', status: 'TRADED', token: '1594', exchange: 'NSE', symbol: 'INFY', paperTradeId: 'p9', currentPrice: 1488, executedPrice: 1500 },
      ]),
      update: jest.fn().mockResolvedValue(undefined),
    };
    exec = { closeTrade: jest.fn().mockResolvedValue(undefined) };
    exitPrice = { resolveExitPrices: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        UngatedTickPoller,
        { provide: AngelOneAdapterService, useValue: adapter },
        { provide: UngatedWatchRepository, useValue: repo },
        { provide: UngatedWatchService, useValue: { onTick: jest.fn() } },
        { provide: UngatedTradeExecutionService, useValue: exec },
        { provide: ExitPriceService, useValue: exitPrice },
      ],
    }).compile();
    poller = mod.get(UngatedTickPoller);
  });

  it('EOD at 15:25 with no fresh price closes at the last known price, not at 0', async () => {
    exitPrice.resolveExitPrices.mockResolvedValue(new Map([['1594', { price: 0, fresh: false, source: 'none' }]]));

    await poller.eodSquareOff();

    expect(exec.closeTrade).toHaveBeenCalledWith('p9', { reason: 'eod-square-off', exitPrice: 1488 });
    expect(repo.update).toHaveBeenCalledWith('u1', expect.objectContaining({ status: 'EXITED', closedReason: 'eod-square-off' }));
  });

  it('closes at the fresh price through ExitPriceService, never the shared adapter', async () => {
    exitPrice.resolveExitPrices.mockResolvedValue(new Map([['1594', { price: 1497, fresh: true, source: 'hub' }]]));

    await poller.eodSquareOff();

    expect(exitPrice.resolveExitPrices).toHaveBeenCalledWith('NSE', ['1594']);
    expect(adapter.getLtpsBatch).not.toHaveBeenCalled();
    expect(exec.closeTrade).toHaveBeenCalledWith('p9', { reason: 'eod-square-off', exitPrice: 1497 });
  });
});
```

Append inside `describe('AnandPriceMonitorService', …)` in `anand-price-monitor.service.spec.ts`:

```typescript
  it('expireIntradayAtClose prices through ExitPriceService, never the shared adapter directly', async () => {
    repo.listWatchingIntraday.mockResolvedValue([makeEntry({ id: 'i3', token: '2885', entryPrice: 2500 })]);
    exitPrice.resolveExitPrices.mockResolvedValue(new Map([['2885', { price: 2561, fresh: true, source: 'hub' as const }]]));

    await service.expireIntradayAtClose();

    expect(exitPrice.resolveExitPrices).toHaveBeenCalledWith('NSE', ['2885']);
    expect(adapter.getLtpsBatch).not.toHaveBeenCalled();
    expect(repo.updateIntradayStatus).toHaveBeenCalledWith('i3', expect.objectContaining({ status: 'EXPIRED', exitPrice: 2561 }));
  });

  it('expireIntradayAtClose marks a not-fresh price as breakeven, never as 0', async () => {
    repo.listWatchingIntraday.mockResolvedValue([makeEntry({ id: 'i4', token: '2885', entryPrice: 2500 })]);
    exitPrice.resolveExitPrices.mockResolvedValue(new Map([['2885', { price: 0, fresh: false, source: 'none' as const }]]));

    await service.expireIntradayAtClose();

    expect(repo.updateIntradayStatus).toHaveBeenCalledWith('i4', expect.objectContaining({ status: 'EXPIRED', exitPrice: 2500 }));
  });
```

In `sell-futures.service.spec.ts`:
- add the import `import { ExitPriceService } from '../../signal-generator/services/exit-price.service';`;
- add at the top level (after `baseInput`):

```typescript
/** One ExitPriceService double for every module in this file; reset before each test. */
const exitPrice = { resolveExitPrices: jest.fn() };
beforeEach(() => {
  exitPrice.resolveExitPrices.mockReset();
  exitPrice.resolveExitPrices.mockResolvedValue(new Map());
});
```

- in each of the first three `Test.createTestingModule({ providers: [ … ] })` calls, add `{ provide: ExitPriceService, useValue: exitPrice },` directly after the `{ provide: AngelOneAdapterService, … },` line;
- replace the whole `describe('SellFuturesService.squareOffOpenPositions — EOD', () => { … });` block with:

```typescript
describe('SellFuturesService.squareOffOpenPositions — EOD', () => {
  let svc: SellFuturesService;
  let repo: any, adapter: any, closeTrade: jest.Mock;

  beforeEach(async () => {
    repo = {
      findAllActive: jest.fn().mockResolvedValue([
        { id: 'sf1', token: '62802', symbol: 'RELIANCE', exchange: 'NFO', status: 'TRADED',
          paperTradeId: 'sft1', executedPrice: 1200, currentPrice: 1190 },
      ]),
      update: jest.fn().mockResolvedValue({}),
      createEvent: jest.fn(),
    };
    adapter = { getLtpsBatch: jest.fn().mockResolvedValue(new Map([['62802', 1]])) }; // must never be asked
    closeTrade = jest.fn().mockResolvedValue({});
    const mod = await Test.createTestingModule({
      providers: [
        SellFuturesService,
        { provide: SellFuturesWatchRepository, useValue: repo },
        { provide: SellFuturesTradeRepository, useValue: { getTradeById: jest.fn(), update: jest.fn() } },
        { provide: SellFuturesPaperAccountService, useValue: { applyExit: jest.fn() } },
        { provide: FutureSelectorService, useValue: {} },
        { provide: AngelOneAdapterService, useValue: adapter },
        { provide: ExitPriceService, useValue: exitPrice },
      ],
    }).compile();
    svc = mod.get(SellFuturesService);
    (svc as any).closeTrade = closeTrade;
  });

  it('closes every TRADED entry at the fresh futures price from ExitPriceService with reason eod-square-off', async () => {
    exitPrice.resolveExitPrices.mockResolvedValue(new Map([['62802', { price: 1185, fresh: true, source: 'hub' }]]));

    const res = await svc.squareOffOpenPositions();

    expect(exitPrice.resolveExitPrices).toHaveBeenCalledWith('NFO', ['62802']);
    expect(adapter.getLtpsBatch).not.toHaveBeenCalled();
    expect(res.closed).toBe(1);
    expect(closeTrade).toHaveBeenCalledWith('sft1', expect.objectContaining({ reason: 'eod-square-off', exitPrice: 1185 }));
    expect(repo.update).toHaveBeenCalledWith('sf1', expect.objectContaining({ status: 'EXITED', closedReason: 'eod-square-off' }));
  });

  it('with no fresh price it closes at the last known price, never at 0', async () => {
    exitPrice.resolveExitPrices.mockResolvedValue(new Map([['62802', { price: 0, fresh: false, source: 'none' }]]));

    await svc.squareOffOpenPositions();

    expect(closeTrade).toHaveBeenCalledWith('sft1', expect.objectContaining({ exitPrice: 1190 }));
  });

  it('keys prices by exchange + token, so a same-token entry on another exchange is not priced by it', async () => {
    repo.findAllActive.mockResolvedValue([
      { id: 'sf1', token: '62802', symbol: 'RELIANCE', exchange: 'NFO', status: 'TRADED', paperTradeId: 'sft1', executedPrice: 1200, currentPrice: 1190 },
      { id: 'sf2', token: '62802', symbol: 'GOLDM', exchange: 'MCX', status: 'TRADED', paperTradeId: 'sft2', executedPrice: 72000, currentPrice: 71950 },
    ]);
    exitPrice.resolveExitPrices.mockImplementation(async (exchange: string) =>
      exchange === 'NFO' ? new Map([['62802', { price: 1185, fresh: true, source: 'hub' }]]) : new Map(),
    );

    await svc.squareOffOpenPositions();

    expect(closeTrade).toHaveBeenCalledWith('sft1', expect.objectContaining({ exitPrice: 1185 }));
    expect(closeTrade).toHaveBeenCalledWith('sft2', expect.objectContaining({ exitPrice: 71950 }));
  });
});
```

In `breakout-swing-poller.service.spec.ts`:
- replace the import line `import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';` with `import { ExitPriceService, type ExitPriceSource } from '../../signal-generator/services/exit-price.service';`;
- replace the whole `describe('BreakoutSwingPollerService — poller integration', () => { … });` block with:

```typescript
describe('BreakoutSwingPollerService — poller integration', () => {
  let svc: BreakoutSwingPollerService;
  let repo: any;
  let exitPrice: { resolveExitPrices: jest.Mock };
  /** ExitPriceService's answer: every listed token fresh at its price. */
  const fresh = (prices: Record<string, number>, source: ExitPriceSource = 'rest-batch') =>
    new Map(Object.entries(prices).map(([token, price]) => [token, { price, fresh: true, source }]));

  beforeEach(async () => {
    repo = {
      listQueued: jest.fn().mockResolvedValue([]),
      listTraded: jest.fn().mockResolvedValue([]),
      fill: jest.fn().mockResolvedValue(undefined),
      setTrailing: jest.fn().mockResolvedValue(undefined),
      recordTick: jest.fn().mockResolvedValue(undefined),
      updateStatus: jest.fn().mockResolvedValue(undefined),
    };
    exitPrice = { resolveExitPrices: jest.fn().mockResolvedValue(new Map()) };
    const mod = await Test.createTestingModule({
      providers: [
        BreakoutSwingPollerService,
        { provide: BreakoutSwingRepository, useValue: repo },
        { provide: ExitPriceService, useValue: exitPrice },
      ],
    }).compile();
    svc = mod.get(BreakoutSwingPollerService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fills a QUEUED entry when LTP reaches the resting limit → TRADED with qty + stop', async () => {
    repo.listQueued.mockResolvedValue([{ id: 'q1', symbol: 'TCS', token: '11536', limitPrice: 101 }]);
    exitPrice.resolveExitPrices.mockResolvedValue(fresh({ '11536': 101.5 }));

    await svc.pollMarketHours();

    expect(exitPrice.resolveExitPrices).toHaveBeenCalledWith('NSE', ['11536']);
    const call = repo.fill.mock.calls[0];
    expect(call[0]).toBe('q1');
    expect(call[1].entryPrice).toBe(101.5);
    expect(call[1].quantity).toBe(Math.floor(NOTIONAL / 101.5));
    expect(call[1].stopPrice).toBeCloseTo(101.5 * (1 - INIT_STOP_PCT / 100), 6);
  });

  it('does NOT fill a QUEUED entry when LTP is below the resting limit', async () => {
    repo.listQueued.mockResolvedValue([{ id: 'q1', symbol: 'TCS', token: '11536', limitPrice: 101 }]);
    exitPrice.resolveExitPrices.mockResolvedValue(fresh({ '11536': 100.5 }));

    await svc.pollMarketHours();

    expect(repo.fill).not.toHaveBeenCalled();
    // Still resting, but the live price must be persisted so the UI shows
    // Price + Dist-to-Fill instead of "—".
    expect(repo.recordTick).toHaveBeenCalledWith('q1', expect.objectContaining({ currentPrice: 100.5 }));
  });

  it('persists a QUEUED price from whichever tier ExitPriceService used (here a single quote)', async () => {
    repo.listQueued.mockResolvedValue([{ id: 'q1', symbol: 'KIRLPNU', token: '15180', limitPrice: 1817.87 }]);
    exitPrice.resolveExitPrices.mockResolvedValue(fresh({ '15180': 1794.3 }, 'rest-single'));

    await svc.pollMarketHours();

    expect(repo.recordTick).toHaveBeenCalledWith('q1', expect.objectContaining({ currentPrice: 1794.3 }));
    expect(repo.fill).not.toHaveBeenCalled(); // 1794.3 < 1817.87
  });

  it('a QUEUED entry with no fresh price is neither recorded nor filled', async () => {
    repo.listQueued.mockResolvedValue([{ id: 'q1', symbol: 'KIRLPNU', token: '15180', limitPrice: 1 }]);
    exitPrice.resolveExitPrices.mockResolvedValue(new Map([['15180', { price: 0, fresh: false, source: 'none' }]]));

    await svc.pollMarketHours();

    expect(repo.recordTick).not.toHaveBeenCalled();
    expect(repo.fill).not.toHaveBeenCalled();
  });

  it('arms the trailing stop on a TRADED entry once it is up +7%', async () => {
    // 11:30 IST: mid-session, before the 15:15 big-mover window.
    jest.useFakeTimers({ now: new Date('2026-06-12T06:00:00Z') });
    repo.listTraded.mockResolvedValue([
      { id: 't1', symbol: 'TCS', token: '11536', entryPrice: 100, prevDayClose: 95, stopPrice: 90, trailing: false, trailingHighWater: null },
    ]);
    exitPrice.resolveExitPrices.mockResolvedValue(fresh({ '11536': 108 }));

    await svc.pollMarketHours();

    expect(repo.recordTick).toHaveBeenCalledWith('t1', expect.objectContaining({ currentPrice: 108 }));
    const setCall = repo.setTrailing.mock.calls[0];
    expect(setCall[0]).toBe('t1');
    expect(setCall[1].trailingHighWater).toBe(108);
    expect(setCall[1].stopPrice).toBeCloseTo(108 * (1 - TRAIL_GIVEBACK_PCT / 100), 6);
    expect(repo.updateStatus).not.toHaveBeenCalled();
  });

  it('big-mover EOD: force-exits a TRADED entry as BIG_MOVER_EOD inside the 15:15 window', async () => {
    jest.useFakeTimers({ now: new Date('2026-06-12T09:46:00Z') }); // 15:16 IST
    repo.listTraded.mockResolvedValue([
      { id: 't1', symbol: 'TCS', token: '11536', entryPrice: 100, prevDayClose: 95, stopPrice: 90, trailing: false, trailingHighWater: null },
    ]);
    exitPrice.resolveExitPrices.mockResolvedValue(fresh({ '11536': 108 }, 'hub')); // +8% FROM ENTRY → locked in the window

    await svc.pollMarketHours();

    expect(repo.updateStatus).toHaveBeenCalledWith('t1', expect.objectContaining({ status: 'BIG_MOVER_EOD', exitPrice: 108 }));
  });

  it('a TRADED entry whose price is not fresh is not exited on it, even in the EOD window', async () => {
    jest.useFakeTimers({ now: new Date('2026-06-12T09:46:00Z') }); // 15:16 IST
    repo.listTraded.mockResolvedValue([
      { id: 't1', symbol: 'TCS', token: '11536', entryPrice: 100, prevDayClose: 95, stopPrice: 90, trailing: false, trailingHighWater: null },
    ]);
    exitPrice.resolveExitPrices.mockResolvedValue(new Map([['11536', { price: 0, fresh: false, source: 'none' }]]));

    await svc.pollMarketHours();

    expect(repo.updateStatus).not.toHaveBeenCalled();
    expect(repo.recordTick).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @td/api test -- adaptive-stop-tick-poller.service.spec ungated-tick-poller.service.spec anand-price-monitor.service.spec sell-futures.service.spec breakout-swing-poller.service.spec`
Expected: FAIL.
- The EOD tests see `adapter.getLtpsBatch` called (at price 1), and `resolveExitPrices` never called.
- Anand calls the adapter.
- Sell-futures cannot resolve `ExitPriceService`, or closes at the adapter's 1.
- Breakout-swing cannot resolve `AngelOneAdapterService` (the provider was removed from its spec).

- [ ] **Step 3: Implement**

`adaptive-stop-tick-poller.service.ts`:
- delete the `AngelOneAdapterService` import and the `private readonly adapter: AngelOneAdapterService,` constructor parameter;
- change the `ExitPriceService` import to `import { ExitPriceService, type ExitPrice } from '../../signal-generator/services/exit-price.service';`;
- in `eodSquareOff`, replace

```typescript
    const ltpMap = await this.adapter.getLtpsBatch('NSE', tokens).catch(() => new Map<string, number>());
```

with

```typescript
    // Through ExitPriceService (hub first behind HUB_PRICES_TRACKS); only a FRESH price is used.
    const prices = await this.exitPrice.resolveExitPrices('NSE', tokens).catch(() => new Map<string, ExitPrice>());
```

and replace

```typescript
        const exitPrice =
          ltpMap.get(entry.token) ??
```

with

```typescript
        const live = prices.get(entry.token);
        const exitPrice =
          (live?.fresh ? live.price : undefined) ??
```

(the remaining `(entry as any).currentPrice ?? (entry as any).executedPrice ?? 0;` lines are unchanged.)

`ungated-tick-poller.service.ts`: exactly the same three edits, in `eodSquareOff`: delete the adapter import and constructor parameter; import `type ExitPrice`; `prices` from `this.exitPrice.resolveExitPrices('NSE', tokens).catch(() => new Map<string, ExitPrice>())`; `const live = prices.get(entry.token);` and `(live?.fresh ? live.price : undefined) ??` in place of `ltpMap.get(entry.token) ??`.

`anand-price-monitor.service.ts`:
- change the `ExitPriceService` import to `import { ExitPriceService, type ExitPrice } from '../../signal-generator/services/exit-price.service';`;
- in `expireIntradayAtClose`, replace

```typescript
    const ltpMap = tokens.length
      ? await this.adapter.getLtpsBatch('NSE', tokens).catch(() => new Map<string, number>())
      : new Map<string, number>();
```

with

```typescript
    // Through ExitPriceService (hub first behind HUB_PRICES_TRACKS); only a FRESH price is used.
    const prices = tokens.length
      ? await this.exitPrice.resolveExitPrices('NSE', tokens).catch(() => new Map<string, ExitPrice>())
      : new Map<string, ExitPrice>();
```

and replace `const ltp = entry.token ? ltpMap.get(entry.token) : undefined;` with

```typescript
      const live = entry.token ? prices.get(entry.token) : undefined;
      const ltp = live?.fresh ? live.price : undefined;
```

`sell-futures.service.ts`:
- add `import { ExitPriceService, type ExitPrice } from '../../signal-generator/services/exit-price.service';`;
- add `private readonly exitPrice: ExitPriceService,` as the last constructor parameter;
- in `squareOffOpenPositions`, replace

```typescript
    const ltpMap = new Map<string, number>();
    for (const [exchange, tokens] of byExchange) {
      const m = await this.adapter
        .getLtpsBatch(exchange, [...new Set(tokens)])
        .catch(() => new Map<string, number>());
      for (const [tok, ltp] of m) ltpMap.set(tok, ltp);
    }
```

with

```typescript
    // Through ExitPriceService (hub first behind HUB_PRICES_TRACKS), keyed EXCHANGE:token:
    // tokens collide across exchanges. Only a FRESH price is used.
    const prices = new Map<string, ExitPrice>();
    for (const [exchange, tokens] of byExchange) {
      const m = await this.exitPrice
        .resolveExitPrices(exchange, [...new Set(tokens)])
        .catch(() => new Map<string, ExitPrice>());
      for (const [tok, p] of m) prices.set(`${exchange}:${tok}`, p);
    }
```

and, inside the `for (const entry of traded)` loop's `try`, replace

```typescript
        const exitPrice =
          ltpMap.get(entry.token) ??
```

with

```typescript
        const live = prices.get(`${entry.exchange}:${entry.token}`);
        const exitPrice =
          (live?.fresh ? live.price : undefined) ??
```

(the remaining `(entry as any).currentPrice ?? (entry as any).executedPrice ?? 0;` lines are unchanged.)

`breakout-swing-poller.service.ts`:
- replace the `AngelOneAdapterService` import with `import { ExitPriceService, type ExitPrice } from '../../signal-generator/services/exit-price.service';`;
- change the constructor to

```typescript
  constructor(
    private readonly repo: BreakoutSwingRepository,
    private readonly exitPrice: ExitPriceService,
  ) {}
```

- in `fillQueued`, replace from `const ltpMap = await this.adapter.getLtpsBatch('NSE', tokens)…` through the closing `}` of the `if (ltp === undefined) { … getLiveQuote … }` block with:

```typescript
    // ExitPriceService tries the hub (HUB_PRICES_TRACKS), the batch, a single quote and a
    // fresh level book; only a FRESH price drives a fill.
    const prices = await this.exitPrice.resolveExitPrices('NSE', tokens).catch(() => new Map<string, ExitPrice>());
    const now = new Date();

    for (const entry of withToken) {
      const p = prices.get(entry.token as string);
      const ltp = p?.fresh ? p.price : undefined;
```

  (the following `if (ltp === undefined || !(ltp > 0)) { … continue; }` and the rest of the loop are unchanged);
- in `manageTraded`, replace

```typescript
    const ltpMap = await this.adapter.getLtpsBatch('NSE', tokens).catch(() => new Map<string, number>());
    const now = new Date();

    for (const entry of withToken) {
      const ltp = ltpMap.get(entry.token as string);
```

with

```typescript
    const prices = await this.exitPrice.resolveExitPrices('NSE', tokens).catch(() => new Map<string, ExitPrice>());
    const now = new Date();

    for (const entry of withToken) {
      const p = prices.get(entry.token as string);
      const ltp = p?.fresh ? p.price : undefined;
```

- in the class doc comment, replace `Mirrors AdaptiveStopTickPoller: a single batched LTP call sidesteps the broker's ~50-token WebSocket cap.` with `Prices come from ExitPriceService (hub first behind HUB_PRICES_TRACKS, then the legacy tiers); only fresh prices act.`

- [ ] **Step 4: Run tests to verify they pass, including the architecture ratchet**

Run: `pnpm --filter @td/api test -- adaptive-stop-tick-poller.service.spec ungated-tick-poller.service.spec anand-price-monitor.service.spec reinvest-monitor.spec sell-futures.service.spec breakout-swing-poller.service.spec only-door.spec`
Expected: PASS.
Run: `pnpm --filter @td/api test -- adaptive-stop ungated anand sell-futures breakout-swing`
Expected: PASS. The controller specs mock their pollers, and `AnandPriceMonitorService`'s four-argument constructor in `reinvest-monitor.spec.ts` is unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/adaptive-stop-track/services/adaptive-stop-tick-poller.service.ts apps/api/src/modules/adaptive-stop-track/services/adaptive-stop-tick-poller.service.spec.ts apps/api/src/modules/ungated-track/services/ungated-tick-poller.service.ts apps/api/src/modules/ungated-track/services/ungated-tick-poller.service.spec.ts apps/api/src/modules/anand-dual-track/services/anand-price-monitor.service.ts apps/api/src/modules/anand-dual-track/services/__tests__/anand-price-monitor.service.spec.ts apps/api/src/modules/sell-futures-track/services/sell-futures.service.ts apps/api/src/modules/sell-futures-track/services/sell-futures.service.spec.ts apps/api/src/modules/breakout-swing-track/services/breakout-swing-poller.service.ts apps/api/src/modules/breakout-swing-track/services/breakout-swing-poller.service.spec.ts
git commit -m "fix(tracks): EOD square-offs and breakout-swing price through ExitPriceService, not the dead shared feed" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/api/src/modules/adaptive-stop-track/services/adaptive-stop-tick-poller.service.ts apps/api/src/modules/adaptive-stop-track/services/adaptive-stop-tick-poller.service.spec.ts apps/api/src/modules/ungated-track/services/ungated-tick-poller.service.ts apps/api/src/modules/ungated-track/services/ungated-tick-poller.service.spec.ts apps/api/src/modules/anand-dual-track/services/anand-price-monitor.service.ts apps/api/src/modules/anand-dual-track/services/__tests__/anand-price-monitor.service.spec.ts apps/api/src/modules/sell-futures-track/services/sell-futures.service.ts apps/api/src/modules/sell-futures-track/services/sell-futures.service.spec.ts apps/api/src/modules/breakout-swing-track/services/breakout-swing-poller.service.ts apps/api/src/modules/breakout-swing-track/services/breakout-swing-poller.service.spec.ts
```

---

### Task 9: Verification and production gate

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-sp1-m3-position-pricing.md` (record results in the ledger section at the end)

- [ ] **Step 1: Whole API suite**

Run: `pnpm --filter @td/api test 2>&1 | tail -15`
Expected: every suite passes. Record the totals below. The M2 ledger had 239 suites / 2906 tests; later merges may have added more. M3 adds 2 suites (`underlying.spec`, `market-data.repository.spec`); every other new test extends an existing file.

- [ ] **Step 2: The architecture ratchet is unchanged**

Run: `pnpm --filter @td/api test -- only-door.spec` and `git diff main -- apps/api/src/modules/market-hub/only-door.spec.ts`
Expected: PASS and an empty diff (`KNOWN_VIOLATORS` did not grow).

- [ ] **Step 3: Typecheck the files this plan touched**

Run: `pnpm --filter @td/api exec tsc --noEmit -p tsconfig.json 2>&1 | grep -E "market-hub|trade-tracker|tick-source|context-packet|exit-price|adaptive-stop-tick-poller|ungated-tick-poller|anand-price-monitor|sell-futures.service|breakout-swing-poller|market-data.repository|configuration" || echo "no errors in M3 files"`
Expected: `no errors in M3 files`, or only errors on lines unchanged since the merge base. Check with `git blame`, as the M2 ledger did. This includes the pre-existing TS2307 `@td/shared/constants` lines: `market-hub/underlying.ts` will show the same TS2307, which is environmental, the same as in `market-hub.service.ts`. Record it.

- [ ] **Step 4: Record and commit**

Fill in the ledger table below (date, totals, typecheck result), then:

```bash
git commit -m "docs(plans): SP1 M3 verification results" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- docs/superpowers/plans/2026-10-09-sp1-m3-position-pricing.md
```

---

## M3 production gate (after deploy, owner-run)

No migration in M3. After the deploy, set `MARKET_HUB_ENABLED=true` and
`HUB_OWNER_USER_ID=<your users.id>` (both already set if M2's gate ran), then `HUB_PRICES_POSITIONS=true`
and `HUB_PRICES_TRACKS=true`. Over **one full NSE session (09:15–15:30 IST)** with at least one open
position, sample `/healthz/detail` every few minutes and watch the following.

**`hub.value.prices`:**
- `oldestP0AgeMs` < 5000 at every sample while a position or a TRADED track entry is open. P0 is
  open positions only (track exits are priority 3, served by near-live polling).
- `unpricedP0` = 0.

**`hub.value.consumers.positions`:**
- `hub` rises every sweep (~5 per minute per open position).
- `unpriced` stays flat after each position's first minute: `lastUnpricedAt` is never within the last
  5 min in steady state.

**`hub.value.consumers.tracks`:**
- `hub` rises while any track has a TRADED entry.
- `unpriced` stays flat after warm-up. The first resolve of a newly watched token is legitimately
  unpriced.

**Other `hub.value` fields:**
- `consumers.listenerErrors` = 0.
- `slots.criticalOverflow` = 0.
- `governor.endpoints.quote.throttlesLastHour` ≈ 0.

**Database:** the owner's open trackers are seconds old during the session:

```sql
SELECT symbol, exchange, "lastLtp", now() - "updatedAt" AS age
FROM trade_trackers WHERE status = 'OPEN' AND "userId" = '<your users.id>';
-- want: age < 00:00:10 for every row while its exchange is open
```

**Logs:**
- After the first few minutes, no `[trade-tracker] N open token(s) went unpriced` line.
- No `[adaptive-stop-poll] / [ungated-poll] / [sell-futures-poll] / [breakout-swing] … no fresh price`
  line.
- No sentinel `REFUSING to judge` for the owner's positions.
- No `resolved … to underlying NIFTY, but no … cash/index instrument` warning for index options.

**EOD (15:15 / 15:25):**
- The adaptive-stop, sell-futures and ungated square-off logs show `closed … @ ₹<price>` at live
  prices, with no `no exit price … skipping`.
- Anand's `expired with no LTP` warning does not appear for entries the hub watched.

**Revert path:** `HUB_PRICES_POSITIONS=false` and/or `HUB_PRICES_TRACKS=false` puts that consumer back
on its legacy path without a deploy. M3 is complete when this gate is observed in production, not when
the tests pass (parent spec rule).

## Notes for later milestones (not in this plan)

- **Multi-tenant `hubFor`:** one hub per user's own broker session, and `hubFor(userId, …)` returns
  that user's hub. Consumer code does not change. One part is single-user today: the tracker's hub
  tick listener keeps one `hubUserId`, so it becomes a per-user map of listeners and owned sets. The
  legacy market-wide tracker fan-out (one user's session pricing another's trackers) is retired once
  every user with trackers has a hub.
- **Entry-fill quotes and dashboard displays still use the dead shared adapter:**
  - `adaptive-stop-watch.service.ts`, `ungated-watch.service.ts`, `sell-futures.service.ts`
    `createFromAlert` and `breakout-swing.service.ts` (`getLiveQuote` at entry);
  - the adaptive-stop, ungated and anand controllers' `getLtpsBatch`.

  These are not exits or square-offs, so they belong to M6 or to SP6's retirement.
- **Other consumers still on the legacy path:** the gated watch-monitor WebSocket path (M4 `ticks$`),
  stock-monitor (M4/M6), the paper-trade service and `open-paper-trade-refresher` (paper engine,
  needing its own switch), and setup-tracker (M6).
- **New positions reach the hub slowly.** The 60 s `refreshPositions` timer and the 60 s refs cache
  mean a new position joins the hub's watch set within ~2 min, and the legacy REST tier covers it
  until then. If the gate shows unpriced bursts on new positions, push the set to the hub from
  `TradeTrackerService.invalidateOpenTokens`.
- **BFO contracts are not in the instrument master** (`DERIVATIVE_SEGMENTS` is NFO and MCX). A held
  BFO option's underlying stays unresolved. Add BFO there the day one is held, or resolve index names
  from the tradingsymbol prefix.
- **Other index maps.** `market-context.service.ts`, `options-chain.controller.ts`, `backtest.service.ts`
  and `open-paper-trade-refresher.worker.ts` keep their own index maps. Move them onto
  `INDEX_UNDERLYINGS` in M6.
- **Tracker write rate.** Event-driven ticks flush tracker rows every 3 s, against every 12 s before.
  That is fine for the owner's handful of positions; revisit before multi-tenant.
- **SessionClock.** The EOD and poller gates still use their own crons and `isMarketOpen`. Moving
  them onto the SessionClock is parent B2.

## Verification ledger

| Date | Whole suite | Typecheck (M3 files) | Notes |
|---|---|---|---|
| | | | |
