# SP1 · M5 — Option Chain and OI on the Market Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The option chain and OI snapshots come from the owner's market hub (one governed Angel One
session), every chain response carries `at` / `source` / `status`, and a cold chain loads in < 1 s. The
NSE scrape and the legacy per-strike paths stay behind one revert switch until the production gate, then
Task 13 deletes them.

**Architecture:** A new `market-hub/chain/` package builds chains inside the hub: contracts from the DB
instrument master, all legs in one or two Governor-batched FULL quotes, Greeks/IV from one governed
`optionGreek` call (60 s cache, local Black-Scholes fallback), and `oiChange` against the previous
session's last `OISnapshot`. A `ChainService` caches chains, refreshes the ones a screen or a held
position watches every 10 s, serves a closed market from the latest `OptionChainSnapshot`, and runs the
3-minute OI snapshot job. `OptionsChainService` keeps its public API and asks the M3 seam
`hubFor(null, 'chain')`; with `HUB_SERVES_CHAIN` off (or no hub) it runs today's path unchanged, now
labelled with `source` and `at`.

**Tech Stack:** NestJS 11, TypeScript 5.7, Prisma 5 (PostgreSQL + TimescaleDB), Jest 29 (`ts-jest`,
`isolatedModules`) for the API; React 19 + Vite 6 + Vitest 2 (node environment, no DOM renderer) +
Zustand 5 for the web app; pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-11-sp1-m5-option-chain-hub-design.md` (owner decisions (a)–(d),
§3 architecture, §4 data/types/screens, §5 error handling, §6 testing, §7 rollout). Parent:
`docs/superpowers/specs/2026-10-05-sp1-market-data-hub-design.md` §7, §9 M5 row. Builds on the M1–M4
plans (`2026-10-05-sp1-m1-market-hub-core.md` … `2026-10-10-sp1-m4-browser-feed.md`).

**Branch:** `feature/sp1-m5-option-chain-hub`, worktree `.claude/worktrees/sp1-m5-option-chain-hub`,
from `main` at `17058f1`. `node_modules` are junctions to the main checkout (absolute targets).

**Test commands:**
- API: `pnpm --filter @td/api test -- <file-pattern>` (Jest `rootDir` = `apps/api/src`, `testRegex`
  `.*\.spec\.ts$`). Example: `pnpm --filter @td/api test -- chain-builder.spec`.
- Web: `pnpm --filter @td/web test -- <file-pattern>` (`vitest run <filter>`, node environment).
- API typecheck: `pnpm --filter @td/api exec tsc --noEmit -p tsconfig.json`.
- Prisma client after a schema change: `pnpm --filter @td/api exec prisma generate --schema ../../prisma/schema.prisma`
  (writes into the SHARED client in the main checkout; re-run from main after merging).

## Planner rulings (refinements of the spec, made while reading the code)

1. **"Viewed today" means opened on a screen.** Only `GET /api/options/chain` (the Options page and the
   stock preview card) marks an underlying viewed and renews the 10 s refresh watch (`screen: true`).
   Hot-path consumers (scanners, sentinel walls, strike selection, trade-entry PCR) get an on-demand
   build with the same 15 s cache and no standing refresh. Otherwise a universe scan touching ~30 stocks
   would put 30 chains on a 10 s refresh (≈ 6 quote calls/s, over the 5/s budget) and ~300 k OI rows a day
   into the snapshot table. Scanner-only stocks get `oiChange: null`; the strike selector already treats
   a missing value as 0 weight.
2. **Default width ±20 strikes** (`HUB_CHAIN_STRIKES_AROUND`, default 20): 41 strikes × 2 = 82 legs =
   two quote calls. The Options page's strike-range control and the OI-wall / max-pain logic were fed
   the full NSE chain before; ±10 would visibly shrink both.
3. **Full chain JSON every 15 minutes, OI rows every 3 minutes.** `OptionChainSnapshot` rows are ~20 KB;
   writing one per underlying every 3 min is ~450 MB / 30 days on a 20 GB disk. The chain snapshot is
   written every 5th run and at each venue's close (that last one is what the closed-market view and
   the sentinel's overnight review read).
4. **Closed market with no snapshot yet builds once.** Spec §3 says "no broker call" when closed. On
   the first evening after deploy there is no snapshot, so the page would be empty until Monday. A
   closed-market request with neither a cached chain nor a stored snapshot builds once (Interactive
   lane), stores it as a snapshot, and serves it as `market-closed`. After that the rule holds.
5. **`hubFor(null, 'chain')` needs no new rule.** `MarketHubService.hubFor` already serves `null` (system
   work) for every consumer except `'browser'`. The test pins it for `'chain'`.
6. **Expiry dates follow the master's host-local midnight convention.** `master-contract.ts` stores
   `expiry` at host-local midnight and `MarketDataRepository.getNearestFuture` already relies on that.
   The chain repository computes date windows with the same host-local helpers, so writer and reader agree
   on any host timezone (the VPS is UTC, dev machines are IST). Expiry strings are `YYYY-MM-DD`.
7. **`OptionChainSnapshot.source` = `'HUB'`** for hub-written rows; the column is a free string, so no
   migration is needed for it.
8. **Hub chain spot.** The underlying's price comes from the PriceBook when fresh (indices are watched at
   priority 2 by default); otherwise the underlying ref rides in the same quote call as the legs. When no
   spot is known before quoting, strikes are centred on the last known spot (cached chain or snapshot),
   then the median listed strike. `spotPrice` is `null` when no spot was obtained.

## Global Constraints

- **Switches:** `HUB_SERVES_CHAIN` (config `hub.servesChain`) default **false**;
  `HUB_OI_SNAPSHOT_ENABLED` (config `hub.oiSnapshotEnabled`) default **true**;
  `HUB_OI_CORE_UNDERLYINGS` (config `hub.oiCoreUnderlyings`) default
  `NIFTY,BANKNIFTY,FINNIFTY,MIDCPNIFTY,CRUDEOIL,NATURALGAS`; `HUB_CHAIN_STRIKES_AROUND` (config
  `hub.chainStrikesAround`) default **20**. All need `MARKET_HUB_ENABLED=true` and `HUB_OWNER_USER_ID`.
- **Timings:** chain fresh ≤ **15 000 ms**; refresh every **10 000 ms** while watched; screen watch TTL
  **120 000 ms**; Greeks cache **60 000 ms**; OI snapshot every **180 000 ms** in market hours plus one at
  each venue's close; chain JSON snapshot every **5th** OI run and at close; OI retention **30 days**.
- **Lanes:** a caller awaiting a chain uses **Interactive** (5 s deadline → `busy`); refresh and
  snapshots use **Routine**. Greeks go through the `greek` endpoint budget (0.8/s), quotes through
  `quote` (5/s, ≤ 50 refs per call).
- **Never silent:** no synthetic chain, no fixed 15 % IV, no `oiChange` of 0 for "unknown" (`null`), no
  empty chain that looks real (unavailable → REST 503 with a reason). Every chain carries `at`.
- **Instrument keys:** every map and cache keyed by `EXCHANGE:token` (`refKey`) or by
  `UNDERLYING:YYYY-MM-DD`; underlying names are matched **exactly** (CRUDEOIL ≠ CRUDEOILM).
- **trade-core is untouchable:** no edits under `apps/api/src/modules/trade-core/`.
  `UniverseScannerWorker`'s constructor and its calls to `OptionsChainService.getExpiries` /
  `OptionStrikeSelectorService` stay as they are (`trade-core/risk-wall/silo-entry-guards.spec.ts`
  builds it positionally).
- **Only door:** `KNOWN_VIOLATORS` in `only-door.spec.ts` must not grow. The new `optionGreek` call
  lives in `user-feed-session.ts`, which is already listed. Task 13 removes the `options-chain.service.ts`
  entry.
- **Boot must not block:** nothing awaits the broker at boot; `ChainService` timers are `unref`'d;
  `OptionsChainService` resolves the hub lazily through `ModuleRef`.
- **Commits:** explicit pathspecs (`git commit -m "…" -- <paths>`), never a bare `git commit` or `-a`.
  Every message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **A missing OI baseline is "unknown", never 0.** The first session after deploy, a strike that was
   outside yesterday's ±20 band, or a stock first opened today must show `oiChange: null`, and
   `OiWallService` must skip it instead of building "no change" walls. (Task 6 test "oiChange is null
   without a baseline and current − baseline with one"; Task 2 test "OI-change walls skip legs whose
   oiChange is null".)
2. **The hub cannot answer** (throttled, busy, no session, no contracts): a cached or same-day stored
   chain is served as `stale` with its real age; otherwise the REST call is a 503 with the reason and
   internal consumers get `[]`. Nothing returns a chain of zeros. (Task 8 tests "a failed build serves
   the cached chain as stale with its age" and "falls back to today's stored snapshot as stale, and to
   unavailable with the build's reason"; Task 10 tests "an unavailable hub chain is a 503 with the
   reason" and "an unavailable hub chain is an empty chain for internal consumers, never a synthetic one".)
3. **Venues close at different times.** At 16:00 IST NIFTY is closed and CRUDEOIL is open; on an NSE
   holiday MCX may trade. Freshness, refresh and snapshots follow the chain's own venue, and each venue
   gets one closing snapshot. (Task 8 test "a closed venue serves the latest snapshot as market-closed
   while another venue refreshes"; Task 9 tests "writes one closing snapshot when the venue closes, then
   nothing" and "skips a holiday and a closed venue entirely".)
4. **Expiry dates across host timezones.** The VPS runs in UTC, the master stores host-local midnight,
   and users think in IST. A contract expiring today stays listed until the day ends; `2026-10-13` never
   becomes `2026-10-12`. (Task 5 tests "round-trips YYYY-MM-DD through host-local midnight on any host
   timezone", "expiries are host-local YYYY-MM-DD, ascending, distinct, and include today", and the
   contracts test's `expiry: { gte, lt }` window; Task 7 test "expiries come from the repo from today (IST)…".)
5. **Same name, different contract family.** CRUDEOIL options must never pick up CRUDEOILM contracts or
   the mini future as spot; an MCX chain's spot is the future of exactly that name. (Task 5 tests
   "contracts match the underlying name exactly, NFO/MCX CE/PE, one expiry day with the master
   convention" and "an MCX underlying is the nearest future of exactly that name expiring on/after the option".)

---

## File Structure

| Path | Responsibility |
|---|---|
| Modify `apps/api/src/config/configuration.ts`, `deploy/env/api.env.example` | the four new `hub.*` keys |
| Modify `apps/api/src/modules/market-hub/hub-prices.ts` | `HubConsumer` gains `'chain'`; `HubPrices.chains?`; `engineHubPrices` maps it |
| Modify `apps/api/src/modules/market-hub/hub-engine.ts` | `ConsumerFlags.chain`, `consumers.chain`; `quoteNow`, `greeks`; owns `ChainService`; `status().chain` |
| Modify `apps/api/src/modules/market-hub/market-hub.service.ts` | `CONSUMER_FLAG.chain`; builds the chain deps; `hub-oi-prune` cron |
| Modify `apps/api/src/modules/market-hub/hub-broker.ts`, `testing/fake-broker.ts` | `HubBroker.optionGreeks` |
| Create `apps/api/src/modules/market-data/services/user-option-greeks.util.ts` | `greekExpiry(ymd)`, `mapOptionGreeks(raw)` (pure) |
| Modify `apps/api/src/modules/market-data/services/user-feed-session.ts`, `user-feed-manager.service.ts` | `getOptionGreeks` / `fetchOptionGreeks` over the user's own session |
| Create `apps/api/src/modules/market-hub/chain/chain.types.ts` | `ChainContract`, `OptionGreekRow`, `HubChain`, `ChainResult`, `HubChains`, `ChainStatus` |
| Create `apps/api/src/modules/market-hub/chain/chain-dates.ts` | host-local `ymdLocal`, `localMidnight`, `nextYmd`; `expiryCloseAt` |
| Create `apps/api/src/modules/market-hub/chain/chain-repository.ts` | `ChainRepo` + `PrismaChainRepo` |
| Create `apps/api/src/modules/market-hub/testing/memory-chain-repo.ts` | in-memory `ChainRepo` for tests |
| Create `apps/api/src/modules/market-hub/chain/chain-math.ts` | `pickStrikes`, `assembleEntries` (pure) |
| Create `apps/api/src/modules/market-hub/chain/chain-builder.ts` | one chain build: contracts → spot → quotes + Greeks + baseline → `HubChain` |
| Create `apps/api/src/modules/market-hub/chain/chain-service.ts` | `HubChains`: cache, watches, refresh, closed/stale rules, `optionLtp`, status |
| Create `apps/api/src/modules/market-hub/chain/oi-snapshot-job.ts` | 3-minute OI rows, 15-minute chain JSON, closing snapshot |
| Create `prisma/migrations/20261011120000_sp1_m5_option_chain_hub/migration.sql`; modify `prisma/schema.prisma` | `instruments(name, expiry)` index; `oi_snapshots.oiChange` nullable; `oi_snapshots(timestamp)` index |
| Modify `packages/shared/src/types/index.ts` | `OptionData.token?`, `.lotSize?`, `oiChange: number \| null`; `OptionsChainView` |
| Modify `apps/api/src/modules/signal-generator/services/oi-wall.service.ts` | null `oiChange` skipped, not coerced |
| Modify `apps/api/src/modules/options-chain/services/options-chain.service.ts` | hub seam; `getChainView`; legacy path labelled |
| Modify `apps/api/src/modules/options-chain/controllers/options-chain.controller.ts` | `/chain` from `getChainView`; 503 on unavailable |
| Modify `apps/api/src/modules/health/health-detail.service.ts` | `EXPECTED_JOBS` gains `hub-oi-prune` |
| Create `apps/web/src/utils/chainAge.ts` | `chainBadge`, `chainPollMs` (pure) |
| Modify `apps/web/src/stores/options-store.ts`, `hooks/useOptionsChain.ts`, `pages/options/OptionsPage.tsx`, `components/stock-overview/OptionsChainPreviewCard.tsx` | badge, status-driven poll, `fetchAnalysis` removed |

---

### Task 1: The seam: `'chain'` consumer, the four `hub.*` keys, counters

**Files:**
- Modify: `apps/api/src/config/configuration.ts` (the `hub:` block, lines 75–97)
- Modify: `deploy/env/api.env.example` (after `HUB_SERVES_BROWSER`, line 51)
- Modify: `apps/api/src/modules/market-hub/hub-prices.ts`
- Modify: `apps/api/src/modules/market-hub/hub-engine.ts` (`ConsumerFlags`, `consumerCounts`, `HubStatus.consumers`, `status()`)
- Modify: `apps/api/src/modules/market-hub/market-hub.service.ts` (`CONSUMER_FLAG`, `consumerFlags`)
- Test: `apps/api/src/modules/market-hub/market-hub.service.spec.ts`

**Interfaces:**
- Produces: `HubConsumer = 'positions' | 'tracks' | 'browser' | 'chain'`; `ConsumerFlags.chain: boolean`;
  `HubStatus.consumers.chain: ConsumerCounters`; config keys `hub.servesChain` (bool),
  `hub.oiSnapshotEnabled` (bool), `hub.oiCoreUnderlyings` (string), `hub.chainStrikesAround` (number).
  `HubPrices.chains?: HubChains` is added in Task 8 (the type does not exist yet).

- [ ] **Step 1: Write the failing test**

Append to `market-hub.service.spec.ts`, inside the top-level `describe`, next to the existing
`hubFor(…, "browser")` test (reuse its `enabled`, `manager`, `tracker`, `prisma`, `runner`, `instruments` helpers):

```ts
  it('hubFor(…, "chain") serves the owner and system work (null), only with HUB_SERVES_CHAIN on', () => {
    const on = new MarketHubService(enabled({ 'hub.servesChain': true }) as any, manager() as any, tracker as any, prisma as any, runner as any, instruments as any);
    on.onModuleInit();
    // Scanners, sentinel walls and trade-entry PCR have no user: chain data is market-wide.
    expect(on.hubFor(null, 'chain')).not.toBeNull();
    expect(on.hubFor('owner', 'chain')).not.toBeNull();
    expect(on.hubFor('someone-else', 'chain')).toBeNull();
    // 'browser' keeps its never-null rule.
    expect(on.hubFor(null, 'browser')).toBeNull();
    on.record('chain', 'hub', 3);
    expect(on.status()?.consumers.chain.hub).toBe(3);
    expect(on.status()?.consumers.flags.chain).toBe(true);
    on.onModuleDestroy();

    const off = new MarketHubService(enabled() as any, manager() as any, tracker as any, prisma as any, runner as any, instruments as any);
    off.onModuleInit();
    expect(off.hubFor(null, 'chain')).toBeNull();
    expect(off.status()?.consumers.flags.chain).toBe(false);
    off.onModuleDestroy();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @td/api test -- market-hub.service.spec`
Expected: FAIL. `consumers.chain` is undefined (`TypeError: Cannot read properties of undefined (reading 'hub')`).

- [ ] **Step 3: Implement**

`configuration.ts`, inside `hub: { … }` after `servesBrowser`:

```ts
    // M5 consumer switch: the option chain (/api/options, scanners, sentinel walls, trade-entry PCR,
    // single-contract LTP) is built by the hub. Off = today's path (NSE scrape + legacy) — the revert.
    servesChain: process.env.HUB_SERVES_CHAIN === 'true',
    // M5: 3-minute OI snapshots for the core list + held + screen-viewed underlyings. ON by default so
    // the "change vs yesterday" baseline exists before HUB_SERVES_CHAIN is turned on.
    oiSnapshotEnabled: process.env.HUB_OI_SNAPSHOT_ENABLED !== 'false',
    // M5: underlyings that always get OI snapshots (comma-separated master names, exact).
    oiCoreUnderlyings: process.env.HUB_OI_CORE_UNDERLYINGS || 'NIFTY,BANKNIFTY,FINNIFTY,MIDCPNIFTY,CRUDEOIL,NATURALGAS',
    // M5: strikes each side of ATM in a hub chain (20 → 82 legs → two quote calls).
    chainStrikesAround: +(process.env.HUB_CHAIN_STRIKES_AROUND || 20),
```

`deploy/env/api.env.example`, after line 51 (`HUB_SERVES_BROWSER=false`):

```
# SP1 M5 switch (needs MARKET_HUB_ENABLED=true): option chains built by the hub. Off = NSE scrape + legacy.
HUB_SERVES_CHAIN=false
# SP1 M5: 3-minute OI snapshots (baseline for "OI change vs yesterday"). Keep on even while HUB_SERVES_CHAIN is off.
HUB_OI_SNAPSHOT_ENABLED=true
# SP1 M5: always-snapshotted underlyings (exact master names) and chain width (strikes each side of ATM).
HUB_OI_CORE_UNDERLYINGS=NIFTY,BANKNIFTY,FINNIFTY,MIDCPNIFTY,CRUDEOIL,NATURALGAS
HUB_CHAIN_STRIKES_AROUND=20
```

`hub-prices.ts`:

```ts
/** Which consumer switch a caller sits behind: HUB_PRICES_POSITIONS, HUB_PRICES_TRACKS, HUB_SERVES_BROWSER or HUB_SERVES_CHAIN. */
export type HubConsumer = 'positions' | 'tracks' | 'browser' | 'chain';
```

and in the `hubFor` doc comment replace "except that 'browser' never serves null: a browser always has a
user." with "except that 'browser' never serves null: a browser always has a user. ('chain' does serve
null: chain data is market-wide and its consumers are system jobs.)"

`hub-engine.ts`:

```ts
export interface ConsumerFlags {
  positions: boolean;
  tracks: boolean;
  browser: boolean;
  chain: boolean;
}
```

In `HubStatus.consumers` add `chain: ConsumerCounters;` after `browser`. In `consumerCounts` add
`chain: { hub: 0, legacy: 0, unpriced: 0, lastHubAt: null, lastUnpricedAt: null },`. In `status()`:

```ts
        browser: { ...this.consumerCounts.browser },
        chain: { ...this.consumerCounts.chain },
        listenerErrors: this.listenerErrors,
        flags: this.d.consumerFlags?.() ?? { positions: false, tracks: false, browser: false, chain: false },
```

`market-hub.service.ts`:

```ts
const CONSUMER_FLAG: Record<HubConsumer, string> = {
  positions: 'hub.pricesPositions',
  tracks: 'hub.pricesTracks',
  browser: 'hub.servesBrowser',
  chain: 'hub.servesChain',
};
```

and in `onModuleInit`'s `consumerFlags` add `chain: this.consumerEnabled('chain'),`. `hubFor` needs no
change (ruling 5).

- [ ] **Step 4: Run the hub suites**

Run: `pnpm --filter @td/api test -- market-hub`
Expected: PASS. If a `hub-engine.spec` / `market-hub.service.spec` assertion compares the whole
`consumers` or `flags` object with `toEqual`, add `chain` to its expected value (that is the intended change).

- [ ] **Step 5: Commit**

Commit with explicit pathspecs: `configuration.ts`, `api.env.example`, `hub-prices.ts`, `hub-engine.ts`,
`market-hub.service.ts`, `market-hub.service.spec.ts` (and `hub-engine.spec.ts` only if Step 4 touched it).
Message: `feat(market-hub): 'chain' consumer behind HUB_SERVES_CHAIN, OI snapshot and chain-width keys`.

---

### Task 2: Shared chain types; a null `oiChange` means "unknown"

**Files:**
- Modify: `packages/shared/src/types/index.ts` (`OptionData`, lines 133–145; add `OptionsChainView` after it)
- Modify: `apps/api/src/modules/signal-generator/services/oi-wall.service.ts` (`oiChangeWalls`, lines 197–222)
- Test: `apps/api/src/modules/signal-generator/services/oi-wall.service.spec.ts`

**Interfaces:**
- Produces (in `@td/shared/types`):

```ts
export interface OptionData {
  ltp: number;
  oi: number;
  /** OI now minus the contract's last OI of the previous session. null = no baseline (unknown), never 0. */
  oiChange: number | null;
  volume: number;
  /** Percent, e.g. 13.4. */
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  bidPrice: number;
  askPrice: number;
  /** M5 hub chains: the contract's broker token and lot size. Absent on legacy chains. */
  token?: string;
  lotSize?: number;
}

export type OptionsChainSource = 'hub' | 'snapshot' | 'nse' | 'legacy';
export type OptionsChainStatus = 'fresh' | 'stale' | 'market-closed' | 'unavailable';

/** GET /api/options/chain/:underlying — the chain plus where it came from and how old it is. */
export interface OptionsChainView {
  chain: OptionsChainEntry[];
  spotPrice: number | null;
  /** ISO time the chain's prices were current. */
  at: string;
  source: OptionsChainSource;
  status: OptionsChainStatus;
  /** Hub chains: Greeks/IV from the broker, or computed locally from LTP after an optionGreek failure. */
  greeks?: 'broker' | 'local';
  /** status 'unavailable' only: why (throttled, busy, no-session, no-contracts, error). */
  unavailable?: string;
}
```

- [ ] **Step 1: Write the test**

Append to `oi-wall.service.spec.ts`:

```ts
  it('OI-change walls skip legs whose oiChange is null (no baseline), and never read null as a build', async () => {
    const leg = (oi: number, oiChange: number | null) => ({
      ltp: 10, oi, oiChange, volume: 1, iv: 12, delta: 0, gamma: 0, theta: 0, vega: 0, bidPrice: 0, askPrice: 0,
    });
    const chain = [
      { strikePrice: 25100, expiryDate: '2026-10-13', ceData: leg(1000, null), peData: leg(10, null) },
      { strikePrice: 25200, expiryDate: '2026-10-13', ceData: leg(900, 500), peData: leg(10, null) },
      { strikePrice: 24900, expiryDate: '2026-10-13', ceData: leg(10, null), peData: leg(800, null) },
    ];
    const optionsChain = {
      getExpiries: jest.fn().mockResolvedValue(['2026-10-13']),
      getOptionsChain: jest.fn().mockResolvedValue(chain),
    };
    const svc = new OiWallService(optionsChain as any);
    const out = await svc.wallsExtended('NIFTY', 25000);
    expect(out.filter((c) => c.kind === 'OI_CHANGE')).toEqual([{ price: 25200, kind: 'OI_CHANGE', score: 30 }]);
  });
```

- [ ] **Step 2: Run it, and prove it bites**

Run: `pnpm --filter @td/api test -- oi-wall.service.spec`
Expected: PASS already (`null ?? 0` is filtered by `build > 0`). This test pins behaviour the type change
must not break. Prove it bites: temporarily change the call filter to `x.build >= 0`, run, see FAIL with
extra 25100/24900 candidates, then revert.

- [ ] **Step 3: Implement**

`packages/shared/src/types/index.ts`: replace `OptionData` with the version above; add
`OptionsChainSource`, `OptionsChainStatus`, `OptionsChainView` right after it.

`oi-wall.service.ts`: make the null rule explicit (same behaviour, now typed):

```ts
  /** A leg's fresh build-up, or null when the chain has no baseline for it (unknown is not "no build"). */
  private static build(leg: { oiChange?: number | null } | null | undefined): number | null {
    const v = leg?.oiChange;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  private oiChangeWalls(chain: any[], ltp: number): LevelCandidate[] {
    const hasSpot = ltp > 0;
    const callBuilds = chain
      .map((e: any) => ({ price: e.strikePrice as number, build: OiWallService.build(e.ceData) }))
      .filter((x): x is { price: number; build: number } => x.build !== null && x.build > 0 && (!hasSpot || x.price > ltp));
    const putBuilds = chain
      .map((e: any) => ({ price: e.strikePrice as number, build: OiWallService.build(e.peData) }))
      .filter((x): x is { price: number; build: number } => x.build !== null && x.build > 0 && (!hasSpot || x.price < ltp));
```

The rest of the method is unchanged. Change the doc comment's last sentence to: "If the chain exposes no
change-in-OI (all null/zero/absent), this returns [] — no fabrication; null means no baseline yet."

- [ ] **Step 4: Typecheck the readers of the widened type**

Run: `pnpm --filter @td/api exec tsc --noEmit -p tsconfig.json 2>&1 | grep -i "oiChange" || echo "no oiChange type errors"`
Expected: `no oiChange type errors`. Known readers already accept null: `OptionStrikeSelectorService.safeNum`
takes `number | null | undefined`; `overnight-evidence.adapter.ts` checks `Number.isFinite`. If a new error
appears, fix it at that call site by treating null as "no data" (never `?? 0` into arithmetic that means
"no build") and add the file to the commit.
Run: `pnpm --filter @td/web exec tsc --noEmit -p tsconfig.json 2>&1 | grep -i "oiChange" || echo "no web oiChange errors"`
Expected: `no web oiChange errors` (`OptionsChainTable` uses `?? 0` and `formatOI(0)` renders "-";
`OptionsChainPreviewCard` checks `!= null`).

- [ ] **Step 5: Commit**

Pathspecs: `packages/shared/src/types/index.ts`, `oi-wall.service.ts`, `oi-wall.service.spec.ts` (+ any
call site Step 4 fixed). Message: `feat(shared): OptionsChainView, per-leg token/lot size, oiChange null when there is no baseline`.

---

### Task 3: `optionGreek` over the owner's own session

**Files:**
- Create: `apps/api/src/modules/market-hub/chain/chain.types.ts` (first types; Tasks 5–8 append)
- Create: `apps/api/src/modules/market-data/services/user-option-greeks.util.ts`
- Test: `apps/api/src/modules/market-data/services/user-option-greeks.util.spec.ts`
- Modify: `apps/api/src/modules/market-data/services/user-feed-session.ts` (`smartApi` type, line 110; new method after `getQuotes`)
- Modify: `apps/api/src/modules/market-data/services/user-feed-manager.service.ts` (after `fetchQuotes`, ~line 249)
- Modify: `apps/api/src/modules/market-data/services/user-feed.types.ts` (only if `UserFeedSessionLike` lists session methods)
- Modify: `apps/api/src/modules/market-hub/hub-broker.ts`, `apps/api/src/modules/market-hub/testing/fake-broker.ts`
- Test: `apps/api/src/modules/market-hub/hub-broker.spec.ts`

**Interfaces:**
- Produces:
  - `chain/chain.types.ts`: `OptionSide = 'CE' | 'PE'`; `OptionGreekRow { strike; optionType: OptionSide; iv /* percent */; delta; gamma; theta; vega }` (all numbers)
  - `greekExpiry(ymd: string): string` (`'2026-10-13'` → `'13OCT2026'`); `mapOptionGreeks(raw: unknown): OptionGreekRow[]`
  - `UserFeedSession.getOptionGreeks(name, expiryYmd): Promise<OptionGreekRow[]>` (rejects `AngelThrottleError` when throttled)
  - `UserFeedManager.fetchOptionGreeks(userId, name, expiryYmd): Promise<OptionGreekRow[]>`
  - `HubBroker.optionGreeks(name: string, expiryYmd: string): Promise<OptionGreekRow[]>`
  - `FakeBroker.greekCalls: Array<{ name: string; expiry: string }>`; `FakeBroker.greeksImpl`

- [ ] **Step 1: Write the failing tests**

`user-option-greeks.util.spec.ts`:

```ts
import { greekExpiry, mapOptionGreeks } from './user-option-greeks.util';

describe('optionGreek helpers', () => {
  it('formats a YYYY-MM-DD expiry as Angel DDMMMYYYY', () => {
    expect(greekExpiry('2026-10-13')).toBe('13OCT2026');
    expect(greekExpiry('2026-01-05')).toBe('05JAN2026');
  });

  it('maps Angel rows (string numbers, percent IV) and drops rows without a strike or side', () => {
    const rows = mapOptionGreeks([
      { name: 'NIFTY', expiry: '13OCT2026', strikePrice: '25000.000000', optionType: 'CE', delta: '0.52', gamma: '0.0011', theta: '-12.5', vega: '9.8', impliedVolatility: '13.36', tradeVolume: '100' },
      { strikePrice: '25000', optionType: 'PE', delta: '-0.48', gamma: '0.0011', theta: '-11', vega: '9.8', impliedVolatility: '14.1' },
      { strikePrice: '0', optionType: 'CE', delta: '1' },
      { strikePrice: '25100', optionType: 'XX' },
    ]);
    expect(rows).toEqual([
      { strike: 25000, optionType: 'CE', iv: 13.36, delta: 0.52, gamma: 0.0011, theta: -12.5, vega: 9.8 },
      { strike: 25000, optionType: 'PE', iv: 14.1, delta: -0.48, gamma: 0.0011, theta: -11, vega: 9.8 },
    ]);
  });

  it('is [] for anything that is not an array', () => {
    expect(mapOptionGreeks(null)).toEqual([]);
    expect(mapOptionGreeks({ data: [] })).toEqual([]);
  });
});
```

Append to `hub-broker.spec.ts`:

```ts
  it('optionGreeks goes to the owner session through the manager', async () => {
    const rows = [{ strike: 25000, optionType: 'CE', iv: 13, delta: 0.5, gamma: 0.001, theta: -10, vega: 9 }];
    const manager = {
      pin: jest.fn(), unpin: jest.fn(), fetchQuotes: jest.fn(), fetchCandleWindow: jest.fn(),
      addTickListener: jest.fn(), addStateListener: jest.fn(),
      fetchOptionGreeks: jest.fn().mockResolvedValue(rows),
    };
    const broker = new ManagerHubBroker(manager as any, 'owner');
    await expect(broker.optionGreeks('NIFTY', '2026-10-13')).resolves.toEqual(rows);
    expect(manager.fetchOptionGreeks).toHaveBeenCalledWith('owner', 'NIFTY', '2026-10-13');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @td/api test -- user-option-greeks.util.spec hub-broker.spec`
Expected: FAIL: `Cannot find module './user-option-greeks.util'` and `broker.optionGreeks is not a function`.

- [ ] **Step 3: Implement**

`apps/api/src/modules/market-hub/chain/chain.types.ts`:

```ts
export type OptionSide = 'CE' | 'PE';

/** One contract's Greeks from Angel's optionGreek (IV in PERCENT, e.g. 13.36). */
export interface OptionGreekRow {
  strike: number;
  optionType: OptionSide;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}
```

`user-option-greeks.util.ts`:

```ts
import type { OptionGreekRow } from '../../market-hub/chain/chain.types';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** '2026-10-13' → '13OCT2026' (Angel optionGreek `expirydate`). */
export function greekExpiry(ymd: string): string {
  const [y, m, d] = ymd.split('-');
  return `${d}${MONTHS[Number(m) - 1]}${y}`;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Angel's optionGreek rows → OptionGreekRow. Field names per runtime sampling (see the legacy
 * mapOptionGreekData note in options-chain.service.ts): strikePrice, optionType, delta, gamma, theta,
 * vega, impliedVolatility (percent), tradeVolume. No LTP and no OI — those come from the quote call.
 */
export function mapOptionGreeks(raw: unknown): OptionGreekRow[] {
  if (!Array.isArray(raw)) return [];
  const out: OptionGreekRow[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    const strike = num(r?.strikePrice ?? r?.strikeprice);
    const side = String(r?.optionType ?? r?.opttype ?? '').toUpperCase();
    if (strike <= 0 || (side !== 'CE' && side !== 'PE')) continue;
    out.push({
      strike,
      optionType: side,
      iv: num(r.impliedVolatility ?? r.iv),
      delta: num(r.delta),
      gamma: num(r.gamma),
      theta: num(r.theta),
      vega: num(r.vega),
    });
  }
  return out;
}
```

`user-feed-session.ts`: add `optionGreek: Function;` to the `smartApi` field type; import
`{ greekExpiry, mapOptionGreeks }` from `./user-option-greeks.util` and `type { OptionGreekRow }` from
`'../../market-hub/chain/chain.types'`; add after `getQuotes`:

```ts
  /**
   * Greeks + IV for every contract of `name` expiring `expiryYmd`, in ONE call over THIS user's own
   * session (the market hub's `greek` budget paces it). A throttle-shaped answer rejects with
   * AngelThrottleError (throwForMissingData's rule); an empty list is a real "none".
   */
  async getOptionGreeks(name: string, expiryYmd: string): Promise<OptionGreekRow[]> {
    await this.ensureConnected();
    if (!this.smartApi) {
      throw new Error('UserFeedSession has no SmartAPI client after connect');
    }
    const response: any = await this.smartApi.optionGreek({
      name: name.toUpperCase(),
      expirydate: greekExpiry(expiryYmd),
    });
    if (response?.data == null) throwForMissingData(response, `optionGreek (${name} ${expiryYmd})`);
    return mapOptionGreeks(response.data);
  }
```

`user-feed-manager.service.ts`, after `fetchQuotes`:

```ts
  /** Greeks for one underlying + expiry over the user's OWN Angel session (the market hub's chains). */
  async fetchOptionGreeks(userId: string, name: string, expiryYmd: string) {
    const entry = this.getOrCreateEntry(userId);
    return entry.session.getOptionGreeks(name, expiryYmd);
  }
```

If `UserFeedSessionLike` (`user-feed.types.ts`) declares the session's methods, add
`getOptionGreeks(name: string, expiryYmd: string): Promise<OptionGreekRow[]>;` to it.

`hub-broker.ts`: `import type { OptionGreekRow } from './chain/chain.types';`, add to `HubBroker`:

```ts
  /** ONE optionGreek call (Greeks + IV for every strike of one expiry). Rejects with AngelThrottleError when throttled. */
  optionGreeks(name: string, expiryYmd: string): Promise<OptionGreekRow[]>;
```

add `'fetchOptionGreeks'` to `ManagerHubBroker`'s `Pick<UserFeedManager, …>`, and:

```ts
  optionGreeks(name: string, expiryYmd: string): Promise<OptionGreekRow[]> {
    return this.manager.fetchOptionGreeks(this.ownerUserId, name, expiryYmd);
  }
```

`testing/fake-broker.ts`: `import type { OptionGreekRow } from '../chain/chain.types';` and add:

```ts
  readonly greekCalls: Array<{ name: string; expiry: string }> = [];
  greeksImpl: (name: string, expiry: string) => Promise<OptionGreekRow[]> = async () => [];
  optionGreeks(name: string, expiry: string): Promise<OptionGreekRow[]> {
    this.greekCalls.push({ name, expiry });
    return this.greeksImpl(name, expiry);
  }
```

- [ ] **Step 4: Run the tests and the ratchet**

Run: `pnpm --filter @td/api test -- user-option-greeks.util.spec hub-broker.spec only-door.spec user-feed`
Expected: PASS. `only-door.spec` stays green: the new `.optionGreek(` lives in `user-feed-session.ts`,
already in `KNOWN_VIOLATORS`.

- [ ] **Step 5: Commit**

Pathspecs: the eight files above (`user-feed.types.ts` only if changed). Message:
`feat(market-hub): optionGreek over the owner's own session, behind HubBroker`.

---

### Task 4: Engine primitives: `quoteNow` and `greeks` through the Governor

**Files:**
- Modify: `apps/api/src/modules/market-hub/hub-engine.ts` (constructor, ~lines 150–165; new methods after `prices`)
- Test: `apps/api/src/modules/market-hub/hub-engine.spec.ts`

**Interfaces:**
- Consumes: `HubBroker.optionGreeks` (Task 3); `QuoteBatcher.quote(ref, lane): Promise<QuoteOutcome>`; `Governor.submit`.
- Produces:
  - `HubEngine.quoteNow(refs: readonly InstrumentRef[], lane: Lane): Promise<Map<string, QuoteOutcome>>` —
    keyed by `refKey`; the SAME `QuoteBatcher` as the poller (150 ms window, ≤ 50 refs/call, one token per chunk). Never rejects.
  - `HubEngine.greeks(name: string, expiryYmd: string, lane: Lane): Promise<GovResult<OptionGreekRow[]>>` —
    `greek` endpoint, coalescing key `greek:NAME:YYYY-MM-DD`. Never rejects.

- [ ] **Step 1: Write the failing tests**

Append to `hub-engine.spec.ts` inside `describe('HubEngine', …)`:

```ts
  it('quoteNow batches 82 legs into two governed quote calls, keyed by EXCHANGE:token', async () => {
    const { e, broker } = engine();
    await e.start();
    broker.quoteCalls.length = 0;
    const refs = Array.from({ length: 82 }, (_, i) => ({ exchange: 'NFO' as const, token: String(40000 + i), symbol: `L${i}` }));
    const p = e.quoteNow(refs, 1);
    await jest.advanceTimersByTimeAsync(1000);
    const out = await p;
    expect(broker.quoteCalls.map((c) => c.length)).toEqual([50, 32]);
    expect(out.size).toBe(82);
    expect(out.get('NFO:40000')).toEqual({ kind: 'ok', tick: expect.objectContaining({ ltp: 100 }) });
    e.stop();
  });

  it('greeks uses the greek budget, merges identical calls, and reports a throttle instead of throwing', async () => {
    const { AngelThrottleError } = await import('../market-data/services/angel-throttle');
    const { e, broker } = engine();
    await e.start();
    broker.greeksImpl = async () => [{ strike: 25000, optionType: 'CE', iv: 13, delta: 0.5, gamma: 0.001, theta: -10, vega: 9 }];
    const [a, b] = await Promise.all([e.greeks('NIFTY', '2026-10-13', 1), e.greeks('NIFTY', '2026-10-13', 1)]);
    expect(a.kind).toBe('ok');
    expect(b).toEqual(a);
    expect(broker.greekCalls).toEqual([{ name: 'NIFTY', expiry: '2026-10-13' }]);

    broker.greeksImpl = async () => {
      throw new AngelThrottleError('rate');
    };
    const pending = e.greeks('BANKNIFTY', '2026-10-13', 1);
    await jest.advanceTimersByTimeAsync(2000);
    expect((await pending).kind).toBe('throttled');
    e.stop();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @td/api test -- hub-engine.spec`
Expected: FAIL: `e.quoteNow is not a function` / `e.greeks is not a function`.

- [ ] **Step 3: Implement**

In `hub-engine.ts` import `type GovResult` from `./governor`, `type QuoteOutcome` from `./quote-batcher`,
`type { OptionGreekRow }` from `./chain/chain.types`. Promote the batcher to a field
(`private readonly batcher: QuoteBatcher;`), and in the constructor replace
`const batcher = new QuoteBatcher(this.governor, (refs) => d.broker.quotes(refs));` with
`this.batcher = new QuoteBatcher(this.governor, (refs) => d.broker.quotes(refs));` and pass
`batcher: this.batcher` to `QuotePoller`. Add after `prices()`:

```ts
  /**
   * Quote these refs now through the poller's batcher (150 ms window, ≤ 50 per call, one token per
   * chunk) on `lane`. Never rejects: each ref gets its own outcome. Does not write the PriceBook
   * (chain legs are not watched; a book entry would read as `not-watched` anyway).
   */
  async quoteNow(refs: readonly InstrumentRef[], lane: Lane): Promise<Map<string, QuoteOutcome>> {
    const outs = await Promise.all(refs.map((r) => this.batcher.quote(r, lane)));
    return new Map(refs.map((r, i) => [refKey(r), outs[i]] as const));
  }

  /** One optionGreek call on the `greek` budget; identical in-flight calls merge. Never rejects. */
  greeks(name: string, expiryYmd: string, lane: Lane): Promise<GovResult<OptionGreekRow[]>> {
    const n = name.toUpperCase();
    return this.governor.submit({
      endpoint: 'greek',
      lane,
      key: `greek:${n}:${expiryYmd}`,
      run: () => this.d.broker.optionGreeks(n, expiryYmd),
    });
  }
```

- [ ] **Step 4: Run the hub suites**

Run: `pnpm --filter @td/api test -- market-hub`
Expected: PASS.

- [ ] **Step 5: Commit**

Pathspecs: `hub-engine.ts`, `hub-engine.spec.ts`. Message: `feat(market-hub): quoteNow and greeks, both through the Governor`.

---

### Task 5: Migration, chain dates, and the chain repository

**Files:**
- Modify: `prisma/schema.prisma` (`Instrument` indexes, line ~44; `OISnapshot`, lines 87–98)
- Create: `prisma/migrations/20261011120000_sp1_m5_option_chain_hub/migration.sql`
- Modify: `apps/api/src/modules/market-hub/chain/chain.types.ts` (append)
- Create: `apps/api/src/modules/market-hub/chain/chain-dates.ts`
- Create: `apps/api/src/modules/market-hub/chain/chain-repository.ts`
- Create: `apps/api/src/modules/market-hub/testing/memory-chain-repo.ts`
- Test: `apps/api/src/modules/market-hub/chain/chain-dates.spec.ts`, `apps/api/src/modules/market-hub/chain/chain-repository.spec.ts`

**Interfaces:**
- Consumes: `istDay(ms)`, `istMidnight(ymd): number` (`candles/trading-calendar.ts`); `INDEX_UNDERLYINGS` (`underlying.ts`).
- Produces (append to `chain.types.ts`):

```ts
import type { OptionsChainEntry } from '@td/shared/types';
import type { HubExchange, InstrumentRef } from '../hub.types';

/** One option contract from the DB instrument master (strike in rupees). */
export interface ChainContract {
  instrumentId: string;
  ref: InstrumentRef;
  strike: number;
  optionType: OptionSide;
  lotSize: number;
}

/** A built chain. `entries` is the shared wire shape, so snapshots and legacy readers share it. */
export interface HubChain {
  underlying: string;
  /** YYYY-MM-DD */
  expiry: string;
  /** NFO or MCX: the venue whose session decides fresh / market-closed. */
  exchange: HubExchange;
  spot: number | null;
  /** ms epoch the prices were current (the quote call's completion). */
  at: number;
  greeks: 'broker' | 'local';
  entries: OptionsChainEntry[];
}

/** One OI snapshot row (`oi_snapshots`). */
export interface OiRow {
  instrumentId: string;
  oi: number;
  oiChange: number | null;
  volume: number;
  at: Date;
}
```

- `chain-dates.ts`: `ymdLocal(d: Date): string`, `localMidnight(ymd: string): Date`, `nextYmd(ymd: string): string`,
  `expiryCloseAt(ymd: string, exchange: string): Date` (15:30 IST; MCX 23:30 IST).
- `chain-repository.ts`:

```ts
export interface ChainRepo {
  /** Active CE/PE contracts of exactly `name` expiring on `expiry` (YYYY-MM-DD), NFO or MCX. */
  contracts(name: string, expiry: string): Promise<ChainContract[]>;
  /** Distinct expiries (YYYY-MM-DD, ascending) of `name`'s options on or after `today` (IST YYYY-MM-DD). */
  expiries(name: string, today: string): Promise<string[]>;
  /** Where the underlying's price lives: index map, MCX nearest future of exactly `name`, or NSE cash. */
  underlyingRef(name: string, exchange: HubExchange, expiry: string): Promise<InstrumentRef | null>;
  /** Master name + expiry of each derivative ref (held positions → chain keys). Unknown refs are skipped. */
  describe(refs: readonly InstrumentRef[]): Promise<Array<{ name: string; expiry: string }>>;
  /** Each instrument's LAST oi strictly before `before` (within 10 days). */
  baseline(instrumentIds: readonly string[], before: Date): Promise<Map<string, number>>;
  writeOi(rows: readonly OiRow[]): Promise<number>;
  writeChainSnapshot(chain: HubChain): Promise<void>;
  /** Latest stored chain for (underlying, expiry), any source, labelled with the caller's venue; null when none. */
  latestChainSnapshot(underlying: string, expiry: string, exchange: HubExchange): Promise<HubChain | null>;
  pruneOi(before: Date): Promise<number>;
}
export class PrismaChainRepo implements ChainRepo { constructor(prisma: PrismaService) }
```

- `MemoryChainRepo implements ChainRepo` with public arrays `contractsRows`, `oiRows`, `chainSnapshots`,
  maps `underlyings`, `heldInfo`, and a `failBaseline` switch.

- [ ] **Step 1: Write the failing tests**

`chain/chain-dates.spec.ts`:

```ts
import { expiryCloseAt, localMidnight, nextYmd, ymdLocal } from './chain-dates';

describe('chain dates (host-local, as master-contract.ts stores expiries)', () => {
  it('round-trips YYYY-MM-DD through host-local midnight on any host timezone', () => {
    expect(ymdLocal(localMidnight('2026-10-13'))).toBe('2026-10-13');
    expect(localMidnight('2026-10-13').getHours()).toBe(0);
  });

  it('nextYmd crosses month and year ends', () => {
    expect(nextYmd('2026-10-31')).toBe('2026-11-01');
    expect(nextYmd('2026-12-31')).toBe('2027-01-01');
  });

  it('expiry close is 15:30 IST, or 23:30 IST for MCX', () => {
    expect(expiryCloseAt('2026-10-13', 'NFO').toISOString()).toBe('2026-10-13T10:00:00.000Z');
    expect(expiryCloseAt('2026-10-16', 'MCX').toISOString()).toBe('2026-10-16T18:00:00.000Z');
  });
});
```

`chain/chain-repository.spec.ts` (Prisma mocked; asserts the query shapes that carry the rules):

```ts
import { PrismaChainRepo } from './chain-repository';
import { localMidnight } from './chain-dates';

function prismaMock() {
  return {
    instrument: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    oISnapshot: { createMany: jest.fn().mockResolvedValue({ count: 2 }), deleteMany: jest.fn().mockResolvedValue({ count: 5 }) },
    optionChainSnapshot: { create: jest.fn().mockResolvedValue({}), findFirst: jest.fn().mockResolvedValue(null) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
}

describe('PrismaChainRepo', () => {
  it('contracts match the underlying name exactly, NFO/MCX CE/PE, one expiry day with the master convention', async () => {
    const prisma = prismaMock();
    prisma.instrument.findMany.mockResolvedValue([
      { id: 'i1', token: '40001', symbol: 'NIFTY13OCT2625000CE', exchange: 'NFO', strike: 25000, optionType: 'CE', lotSize: 75 },
    ]);
    const repo = new PrismaChainRepo(prisma as any);
    const out = await repo.contracts('nifty', '2026-10-13');
    const where = prisma.instrument.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      name: 'NIFTY',
      exchange: { in: ['NFO', 'MCX'] },
      optionType: { in: ['CE', 'PE'] },
      isActive: true,
      expiry: { gte: localMidnight('2026-10-13'), lt: localMidnight('2026-10-14') },
    });
    expect(out).toEqual([
      { instrumentId: 'i1', ref: { exchange: 'NFO', token: '40001', symbol: 'NIFTY13OCT2625000CE' }, strike: 25000, optionType: 'CE', lotSize: 75 },
    ]);
  });

  it('expiries are host-local YYYY-MM-DD, ascending, distinct, and include today', async () => {
    const prisma = prismaMock();
    prisma.instrument.findMany.mockResolvedValue([{ expiry: localMidnight('2026-10-13') }, { expiry: localMidnight('2026-10-20') }]);
    const repo = new PrismaChainRepo(prisma as any);
    await expect(repo.expiries('NIFTY', '2026-10-13')).resolves.toEqual(['2026-10-13', '2026-10-20']);
    const q = prisma.instrument.findMany.mock.calls[0][0];
    expect(q.where.expiry).toEqual({ gte: localMidnight('2026-10-13') });
    expect(q.distinct).toEqual(['expiry']);
    expect(q.orderBy).toEqual({ expiry: 'asc' });
  });

  it('an MCX underlying is the nearest future of exactly that name expiring on/after the option', async () => {
    const prisma = prismaMock();
    prisma.instrument.findFirst.mockResolvedValue({ token: '472790', symbol: 'CRUDEOIL19OCT26FUT' });
    const repo = new PrismaChainRepo(prisma as any);
    await expect(repo.underlyingRef('CRUDEOIL', 'MCX', '2026-10-16')).resolves.toEqual({ exchange: 'MCX', token: '472790', symbol: 'CRUDEOIL19OCT26FUT' });
    expect(prisma.instrument.findFirst.mock.calls[0][0]).toEqual({
      where: { name: 'CRUDEOIL', exchange: 'MCX', isActive: true, optionType: null, symbol: { endsWith: 'FUT' }, expiry: { gte: localMidnight('2026-10-16') } },
      orderBy: { expiry: 'asc' },
    });
  });

  it('index underlyings come from the index map without a query; stocks from NSE cash (-EQ first)', async () => {
    const prisma = prismaMock();
    const repo = new PrismaChainRepo(prisma as any);
    await expect(repo.underlyingRef('NIFTY', 'NFO', '2026-10-13')).resolves.toEqual({ exchange: 'NSE', token: '99926000', symbol: expect.any(String) });
    expect(prisma.instrument.findFirst).not.toHaveBeenCalled();
    prisma.instrument.findFirst.mockResolvedValueOnce({ token: '2885', symbol: 'RELIANCE-EQ' });
    await expect(repo.underlyingRef('RELIANCE', 'NFO', '2026-10-27')).resolves.toEqual({ exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ' });
    expect(prisma.instrument.findFirst.mock.calls[0][0]).toEqual({ where: { symbol: 'RELIANCE-EQ', exchange: 'NSE' } });
  });

  it('writes OI rows with a NULL oiChange when there was no baseline', async () => {
    const prisma = prismaMock();
    const repo = new PrismaChainRepo(prisma as any);
    const at = new Date('2026-10-13T05:00:00Z');
    await repo.writeOi([
      { instrumentId: 'i1', oi: 1000, oiChange: null, volume: 5, at },
      { instrumentId: 'i2', oi: 2000, oiChange: -50, volume: 6, at },
    ]);
    expect(prisma.oISnapshot.createMany.mock.calls[0][0].data).toEqual([
      { instrumentId: 'i1', oi: BigInt(1000), oiChange: null, volume: BigInt(5), timestamp: at },
      { instrumentId: 'i2', oi: BigInt(2000), oiChange: BigInt(-50), volume: BigInt(6), timestamp: at },
    ]);
  });

  it('stores a chain snapshot as source HUB in the legacy OptionsChainEntry[] shape and reads it back', async () => {
    const prisma = prismaMock();
    const repo = new PrismaChainRepo(prisma as any);
    const entries = [{ strikePrice: 25000, expiryDate: '2026-10-13', ceData: null, peData: null }];
    await repo.writeChainSnapshot({ underlying: 'NIFTY', expiry: '2026-10-13', exchange: 'NFO', spot: null, at: Date.parse('2026-10-13T10:00:00Z'), greeks: 'broker', entries });
    expect(prisma.optionChainSnapshot.create.mock.calls[0][0].data).toEqual({
      underlying: 'NIFTY', expiryDate: new Date('2026-10-13'), spotPrice: 0, source: 'HUB', strikeCount: 1,
      chainJson: entries, capturedAt: new Date('2026-10-13T10:00:00Z'),
    });
    prisma.optionChainSnapshot.findFirst.mockResolvedValue({ spotPrice: '0', capturedAt: new Date('2026-10-13T10:00:00Z'), chainJson: entries });
    await expect(repo.latestChainSnapshot('NIFTY', '2026-10-13', 'NFO')).resolves.toEqual({
      underlying: 'NIFTY', expiry: '2026-10-13', exchange: 'NFO', spot: null, at: Date.parse('2026-10-13T10:00:00Z'), greeks: 'broker', entries,
    });
  });

  it('baseline asks for the last row per instrument before the cut-off, as numbers', async () => {
    const prisma = prismaMock();
    prisma.$queryRaw.mockResolvedValue([{ instrumentId: 'i1', oi: BigInt(900) }]);
    const repo = new PrismaChainRepo(prisma as any);
    await expect(repo.baseline(['i1', 'i2'], new Date('2026-10-12T18:30:00Z'))).resolves.toEqual(new Map([['i1', 900]]));
    await expect(repo.baseline([], new Date())).resolves.toEqual(new Map());
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @td/api test -- chain-dates.spec chain-repository.spec`
Expected: FAIL: `Cannot find module './chain-dates'` / `'./chain-repository'`.

- [ ] **Step 3: Schema + migration**

`prisma/schema.prisma`: in `Instrument` add `@@index([name, expiry])` after `@@index([symbol])`. Replace
`OISnapshot` with:

```prisma
model OISnapshot {
  id           String   @id @default(cuid())
  instrumentId String
  instrument   Instrument @relation(fields: [instrumentId], references: [id])
  oi           BigInt
  /// OI minus the contract's last OI of the previous session; NULL = no baseline (SP1 M5).
  oiChange     BigInt?
  volume       BigInt   @default(0)
  timestamp    DateTime

  @@index([instrumentId, timestamp])
  @@index([timestamp])
  @@map("oi_snapshots")
}
```

and change `OptionChainSnapshot.source`'s comment to `// HUB | ANGEL_ONE | NSE | ANGEL_ONE_WS | DB_INSTRUMENTS`.

`prisma/migrations/20261011120000_sp1_m5_option_chain_hub/migration.sql`:

```sql
-- SP1 M5: option chain + OI snapshots on the market hub.
-- oiChange is NULL when there is no previous-session baseline ("unknown" is not 0).
ALTER TABLE "oi_snapshots" ALTER COLUMN "oiChange" DROP NOT NULL;
ALTER TABLE "oi_snapshots" ALTER COLUMN "oiChange" DROP DEFAULT;
-- 30-day prune scans by time.
CREATE INDEX IF NOT EXISTS "oi_snapshots_timestamp_idx" ON "oi_snapshots"("timestamp");
-- Chain contract lookup: name + expiry over every derivative contract in the master.
CREATE INDEX IF NOT EXISTS "instruments_name_expiry_idx" ON "instruments"("name", "expiry");
```

Run: `pnpm --filter @td/api exec prisma generate --schema ../../prisma/schema.prisma`
Expected: `Generated Prisma Client`.

- [ ] **Step 4: Implement `chain-dates.ts`**

```ts
/**
 * Dates for chains, in the instrument master's convention: master-contract.ts stores `expiry` at
 * HOST-LOCAL midnight (MarketDataRepository.getNearestFuture relies on the same). Reading with the
 * same host-local helpers makes writer and reader agree on any host timezone (the VPS is UTC).
 */
export function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function localMidnight(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function nextYmd(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return t.toISOString().slice(0, 10);
}

/** When an option on `exchange` expires on `ymd`: 15:30 IST (MCX: 23:30 IST), as an absolute instant. */
export function expiryCloseAt(ymd: string, exchange: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const utcHour = exchange.toUpperCase() === 'MCX' ? 18 : 10; // 23:30 / 15:30 IST
  return new Date(Date.UTC(y, m - 1, d, utcHour, 0));
}
```

- [ ] **Step 5: Implement `chain-repository.ts`**

```ts
import { Prisma } from '@prisma/client';
import type { OptionsChainEntry } from '@td/shared/types';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import type { HubExchange, InstrumentRef } from '../hub.types';
import { INDEX_UNDERLYINGS } from '../underlying';
import type { ChainContract, HubChain, OiRow } from './chain.types';
import { localMidnight, nextYmd, ymdLocal } from './chain-dates';

const DAY_MS = 24 * 60 * 60 * 1000;
const BASELINE_LOOKBACK_MS = 10 * DAY_MS;

export interface ChainRepo {
  contracts(name: string, expiry: string): Promise<ChainContract[]>;
  expiries(name: string, today: string): Promise<string[]>;
  underlyingRef(name: string, exchange: HubExchange, expiry: string): Promise<InstrumentRef | null>;
  describe(refs: readonly InstrumentRef[]): Promise<Array<{ name: string; expiry: string }>>;
  baseline(instrumentIds: readonly string[], before: Date): Promise<Map<string, number>>;
  writeOi(rows: readonly OiRow[]): Promise<number>;
  writeChainSnapshot(chain: HubChain): Promise<void>;
  latestChainSnapshot(underlying: string, expiry: string, exchange: HubExchange): Promise<HubChain | null>;
  pruneOi(before: Date): Promise<number>;
}

/** The chain's database reads and writes. Names are matched EXACTLY (CRUDEOIL ≠ CRUDEOILM). */
export class PrismaChainRepo implements ChainRepo {
  constructor(private readonly prisma: PrismaService) {}

  async contracts(name: string, expiry: string): Promise<ChainContract[]> {
    const rows = await this.prisma.instrument.findMany({
      where: {
        name: name.toUpperCase(),
        exchange: { in: ['NFO', 'MCX'] },
        optionType: { in: ['CE', 'PE'] },
        isActive: true,
        expiry: { gte: localMidnight(expiry), lt: localMidnight(nextYmd(expiry)) },
      },
      select: { id: true, token: true, symbol: true, exchange: true, strike: true, optionType: true, lotSize: true },
    });
    return rows
      .filter((r) => r.strike !== null && (r.optionType === 'CE' || r.optionType === 'PE'))
      .map((r) => ({
        instrumentId: r.id,
        ref: { exchange: r.exchange as HubExchange, token: r.token, symbol: r.symbol },
        strike: Number(r.strike),
        optionType: r.optionType as 'CE' | 'PE',
        lotSize: r.lotSize,
      }));
  }

  async expiries(name: string, today: string): Promise<string[]> {
    const rows = await this.prisma.instrument.findMany({
      where: {
        name: name.toUpperCase(),
        exchange: { in: ['NFO', 'MCX'] },
        optionType: { in: ['CE', 'PE'] },
        isActive: true,
        expiry: { gte: localMidnight(today) },
      },
      select: { expiry: true },
      distinct: ['expiry'],
      orderBy: { expiry: 'asc' },
    });
    return [...new Set(rows.filter((r) => r.expiry).map((r) => ymdLocal(r.expiry as Date)))];
  }

  async underlyingRef(name: string, exchange: HubExchange, expiry: string): Promise<InstrumentRef | null> {
    const n = name.toUpperCase();
    const index = INDEX_UNDERLYINGS[n];
    if (index) return { ...index };
    if (exchange === 'MCX') {
      const fut = await this.prisma.instrument.findFirst({
        where: { name: n, exchange: 'MCX', isActive: true, optionType: null, symbol: { endsWith: 'FUT' }, expiry: { gte: localMidnight(expiry) } },
        orderBy: { expiry: 'asc' },
      });
      return fut ? { exchange: 'MCX', token: fut.token, symbol: fut.symbol } : null;
    }
    for (const symbol of [`${n}-EQ`, n]) {
      const cash = await this.prisma.instrument.findFirst({ where: { symbol, exchange: 'NSE' } });
      if (cash) return { exchange: 'NSE', token: cash.token, symbol: cash.symbol };
    }
    return null;
  }

  async describe(refs: readonly InstrumentRef[]): Promise<Array<{ name: string; expiry: string }>> {
    const derivatives = refs.filter((r) => r.exchange === 'NFO' || r.exchange === 'MCX');
    if (derivatives.length === 0) return [];
    const rows = await this.prisma.instrument.findMany({
      where: { OR: derivatives.map((r) => ({ exchange: r.exchange, token: r.token })) },
      select: { name: true, expiry: true },
    });
    const out = new Map<string, { name: string; expiry: string }>();
    for (const r of rows) {
      if (!r.name || !r.expiry) continue;
      const e = { name: r.name.toUpperCase(), expiry: ymdLocal(r.expiry) };
      out.set(`${e.name}:${e.expiry}`, e);
    }
    return [...out.values()];
  }

  async baseline(instrumentIds: readonly string[], before: Date): Promise<Map<string, number>> {
    if (instrumentIds.length === 0) return new Map();
    const since = new Date(before.getTime() - BASELINE_LOOKBACK_MS);
    const rows = await this.prisma.$queryRaw<Array<{ instrumentId: string; oi: bigint }>>`
      SELECT DISTINCT ON ("instrumentId") "instrumentId", "oi"
      FROM "oi_snapshots"
      WHERE "instrumentId" IN (${Prisma.join([...instrumentIds])})
        AND "timestamp" < ${before} AND "timestamp" >= ${since}
      ORDER BY "instrumentId", "timestamp" DESC`;
    return new Map(rows.map((r) => [r.instrumentId, Number(r.oi)]));
  }

  async writeOi(rows: readonly OiRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const res = await this.prisma.oISnapshot.createMany({
      data: rows.map((r) => ({
        instrumentId: r.instrumentId,
        oi: BigInt(Math.round(r.oi)),
        oiChange: r.oiChange === null ? null : BigInt(Math.round(r.oiChange)),
        volume: BigInt(Math.round(r.volume)),
        timestamp: r.at,
      })),
    });
    return res.count;
  }

  async writeChainSnapshot(chain: HubChain): Promise<void> {
    await this.prisma.optionChainSnapshot.create({
      data: {
        underlying: chain.underlying.toUpperCase(),
        // Same encoding as OptionsChainService.persistSnapshot (a @db.Date column).
        expiryDate: new Date(chain.expiry),
        spotPrice: chain.spot ?? 0,
        source: 'HUB',
        strikeCount: chain.entries.length,
        chainJson: chain.entries as unknown as Prisma.InputJsonValue,
        capturedAt: new Date(chain.at),
      },
    });
  }

  /** A snapshot row does not store its venue; the caller (who knows it from the contracts) passes it. */
  async latestChainSnapshot(underlying: string, expiry: string, exchange: HubExchange): Promise<HubChain | null> {
    const u = underlying.toUpperCase();
    const row = await this.prisma.optionChainSnapshot.findFirst({
      where: { underlying: u, expiryDate: new Date(expiry) },
      orderBy: { capturedAt: 'desc' },
    });
    if (!row) return null;
    const spot = Number(row.spotPrice);
    return {
      underlying: u,
      expiry,
      exchange,
      spot: spot > 0 ? spot : null,
      at: row.capturedAt.getTime(),
      greeks: 'broker',
      entries: row.chainJson as unknown as OptionsChainEntry[],
    };
  }

  async pruneOi(before: Date): Promise<number> {
    const res = await this.prisma.oISnapshot.deleteMany({ where: { timestamp: { lt: before } } });
    return res.count;
  }
}
```

- [ ] **Step 6: Implement `testing/memory-chain-repo.ts`**

```ts
import type { OptionsChainEntry } from '@td/shared/types';
import type { HubExchange, InstrumentRef } from '../hub.types';
import { refKey } from '../hub.types';
import type { ChainRepo } from '../chain/chain-repository';
import type { ChainContract, HubChain, OiRow } from '../chain/chain.types';

/** In-memory ChainRepo for tests; same semantics as PrismaChainRepo (exact names, expiry days). */
export class MemoryChainRepo implements ChainRepo {
  /** name → expiry → contracts */
  readonly contractsRows = new Map<string, Map<string, ChainContract[]>>();
  readonly underlyings = new Map<string, InstrumentRef>();
  /** refKey → { name, expiry } */
  readonly heldInfo = new Map<string, { name: string; expiry: string }>();
  readonly oiRows: OiRow[] = [];
  readonly chainSnapshots: HubChain[] = [];
  failBaseline = false;
  contractCalls = 0;

  addContracts(name: string, expiry: string, contracts: ChainContract[]): void {
    const byExpiry = this.contractsRows.get(name) ?? new Map<string, ChainContract[]>();
    byExpiry.set(expiry, contracts);
    this.contractsRows.set(name, byExpiry);
  }

  async contracts(name: string, expiry: string): Promise<ChainContract[]> {
    this.contractCalls++;
    return this.contractsRows.get(name.toUpperCase())?.get(expiry) ?? [];
  }

  async expiries(name: string, today: string): Promise<string[]> {
    return [...(this.contractsRows.get(name.toUpperCase())?.keys() ?? [])].filter((e) => e >= today).sort();
  }

  async underlyingRef(name: string, _exchange: HubExchange, _expiry: string): Promise<InstrumentRef | null> {
    return this.underlyings.get(name.toUpperCase()) ?? null;
  }

  async describe(refs: readonly InstrumentRef[]): Promise<Array<{ name: string; expiry: string }>> {
    return refs.map((r) => this.heldInfo.get(refKey(r))).filter((x): x is { name: string; expiry: string } => !!x);
  }

  async baseline(instrumentIds: readonly string[], before: Date): Promise<Map<string, number>> {
    if (this.failBaseline) throw new Error('baseline down');
    const out = new Map<string, { at: number; oi: number }>();
    for (const r of this.oiRows) {
      if (!instrumentIds.includes(r.instrumentId) || r.at.getTime() >= before.getTime()) continue;
      const prev = out.get(r.instrumentId);
      if (!prev || r.at.getTime() > prev.at) out.set(r.instrumentId, { at: r.at.getTime(), oi: r.oi });
    }
    return new Map([...out].map(([k, v]) => [k, v.oi]));
  }

  async writeOi(rows: readonly OiRow[]): Promise<number> {
    this.oiRows.push(...rows);
    return rows.length;
  }

  async writeChainSnapshot(chain: HubChain): Promise<void> {
    this.chainSnapshots.push({ ...chain, entries: JSON.parse(JSON.stringify(chain.entries)) as OptionsChainEntry[] });
  }

  async latestChainSnapshot(underlying: string, expiry: string, exchange: HubExchange): Promise<HubChain | null> {
    const rows = this.chainSnapshots.filter((s) => s.underlying === underlying.toUpperCase() && s.expiry === expiry);
    const last = rows.sort((a, b) => b.at - a.at)[0];
    return last ? { ...last, exchange } : null;
  }

  async pruneOi(before: Date): Promise<number> {
    const keep = this.oiRows.filter((r) => r.at.getTime() >= before.getTime());
    const removed = this.oiRows.length - keep.length;
    this.oiRows.splice(0, this.oiRows.length, ...keep);
    return removed;
  }
}
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @td/api test -- chain-dates.spec chain-repository.spec`
Expected: PASS.

- [ ] **Step 8: Commit**

Pathspecs: `prisma/schema.prisma`, the migration directory, `chain.types.ts`, `chain-dates.ts`,
`chain-dates.spec.ts`, `chain-repository.ts`, `chain-repository.spec.ts`, `testing/memory-chain-repo.ts`.
Message: `feat(market-hub): chain repository over the DB master and OI snapshots; oiChange nullable`.

---

### Task 6: Chain math: strike window and leg assembly (pure)

**Files:**
- Create: `apps/api/src/modules/market-hub/chain/chain-math.ts`
- Test: `apps/api/src/modules/market-hub/chain/chain-math.spec.ts`

**Interfaces:**
- Consumes: `ChainContract`, `OptionGreekRow`, `OptionSide` (Tasks 3, 5); `QuoteOutcome` (`quote-batcher.ts`);
  `expiryCloseAt` (Task 5); `GreeksCalculatorService` method shapes (`options-chain/services/greeks-calculator.service.ts`).
- Produces:

```ts
export const RISK_FREE_RATE = 0.065;
/** The two GreeksCalculatorService methods the hub uses (IV is a DECIMAL here, 0.134). */
export interface GreeksMath {
  calculateIV(price: number, spot: number, strike: number, t: number, rate: number, type: OptionSide): number;
  calculateGreeks(spot: number, strike: number, t: number, rate: number, iv: number, type: OptionSide): { delta: number; gamma: number; theta: number; vega: number };
}
export function pickStrikes(contracts: readonly ChainContract[], centre: number | null, n: number): ChainContract[];
export interface AssembleInput {
  contracts: readonly ChainContract[];
  quotes: ReadonlyMap<string, QuoteOutcome>;
  greeks: readonly OptionGreekRow[] | null;
  baseline: ReadonlyMap<string, number>;
  spot: number | null;
  expiry: string;
  exchange: string;
  now: number;
  math: GreeksMath;
}
export function assembleEntries(i: AssembleInput): { entries: OptionsChainEntry[]; greeks: 'broker' | 'local'; quotedLegs: number };
```

- [ ] **Step 1: Write the failing tests**

`chain/chain-math.spec.ts`:

```ts
import { GreeksCalculatorService } from '../../options-chain/services/greeks-calculator.service';
import type { QuoteOutcome } from '../quote-batcher';
import type { ChainContract } from './chain.types';
import { assembleEntries, pickStrikes } from './chain-math';

const contract = (strike: number, side: 'CE' | 'PE', token = `${side}${strike}`): ChainContract => ({
  instrumentId: `id-${token}`,
  ref: { exchange: 'NFO', token, symbol: `NIFTY13OCT26${strike}${side}` },
  strike,
  optionType: side,
  lotSize: 75,
});
const strikes = (from: number, to: number, step: number) => {
  const out: ChainContract[] = [];
  for (let s = from; s <= to; s += step) out.push(contract(s, 'CE'), contract(s, 'PE'));
  return out;
};
const ok = (ltp: number, oi?: number, bid?: number, ask?: number): QuoteOutcome => ({
  kind: 'ok',
  tick: {
    token: 'x', symbol: 'x', ltp, open: 0, high: 0, low: 0, close: 0, volume: 7, oi, timestamp: new Date(),
    depth: bid && ask ? { bids: [{ price: bid, qty: 75, orders: 1 }], asks: [{ price: ask, qty: 75, orders: 1 }] } : undefined,
  },
});
const NOW = Date.parse('2026-10-12T05:00:00Z'); // 10:30 IST, a day before expiry

describe('pickStrikes', () => {
  const all = strikes(24000, 26000, 50); // 41 strikes, 82 contracts
  it('takes n strikes each side of the strike nearest the centre (both sides of each strike)', () => {
    const picked = pickStrikes(all, 25012, 2);
    expect([...new Set(picked.map((c) => c.strike))]).toEqual([24900, 24950, 25000, 25050, 25100]);
    expect(picked).toHaveLength(10);
  });
  it('centres on the median listed strike when no centre is known', () => {
    const picked = pickStrikes(all, null, 1);
    expect([...new Set(picked.map((c) => c.strike))]).toEqual([24950, 25000, 25050]);
  });
  it('clips at the ends of the list', () => {
    expect(new Set(pickStrikes(all, 24000, 3).map((c) => c.strike)).size).toBe(4);
  });
});

describe('assembleEntries', () => {
  const math = new GreeksCalculatorService();
  const ce = contract(25000, 'CE');
  const pe = contract(25000, 'PE');
  const base = {
    contracts: [ce, pe],
    spot: 25010,
    expiry: '2026-10-13',
    exchange: 'NFO',
    now: NOW,
    math,
  };

  it('oiChange is null without a baseline and current − baseline with one', () => {
    const { entries } = assembleEntries({
      ...base,
      quotes: new Map([['NFO:CE25000', ok(120, 5000)], ['NFO:PE25000', ok(110, 7000)]]),
      greeks: null,
      baseline: new Map([['id-CE25000', 4200]]),
    });
    expect(entries[0].ceData?.oiChange).toBe(800);
    expect(entries[0].peData?.oiChange).toBeNull();
  });

  it('carries token, lot size, volume and L1 bid/ask; uses the broker Greeks when present', () => {
    const { entries, greeks } = assembleEntries({
      ...base,
      quotes: new Map([['NFO:CE25000', ok(120, 5000, 119.5, 120.5)], ['NFO:PE25000', ok(110, 7000)]]),
      greeks: [
        { strike: 25000, optionType: 'CE', iv: 13.4, delta: 0.52, gamma: 0.001, theta: -12, vega: 9 },
        { strike: 25000, optionType: 'PE', iv: 14.1, delta: -0.48, gamma: 0.001, theta: -11, vega: 9 },
      ],
      baseline: new Map(),
    });
    expect(greeks).toBe('broker');
    expect(entries[0]).toEqual({
      strikePrice: 25000,
      expiryDate: '2026-10-13',
      ceData: { ltp: 120, oi: 5000, oiChange: null, volume: 7, iv: 13.4, delta: 0.52, gamma: 0.001, theta: -12, vega: 9, bidPrice: 119.5, askPrice: 120.5, token: 'CE25000', lotSize: 75 },
      peData: expect.objectContaining({ ltp: 110, iv: 14.1, bidPrice: 0, askPrice: 0, token: 'PE25000' }),
    });
  });

  it('computes IV and Greeks locally from LTP when a leg has no broker row, and says so', () => {
    const { entries, greeks } = assembleEntries({
      ...base,
      quotes: new Map([['NFO:CE25000', ok(120, 5000)], ['NFO:PE25000', ok(110, 7000)]]),
      greeks: null,
      baseline: new Map(),
    });
    expect(greeks).toBe('local');
    expect(entries[0].ceData!.iv).toBeGreaterThan(1); // percent, not a decimal
    expect(entries[0].ceData!.iv).not.toBe(15);
    expect(entries[0].ceData!.delta).toBeGreaterThan(0);
    expect(entries[0].peData!.delta).toBeLessThan(0);
  });

  it('leaves a leg null when its quote did not come back, and Greeks zero without a spot', () => {
    const { entries, quotedLegs } = assembleEntries({
      ...base,
      spot: null,
      quotes: new Map([['NFO:CE25000', ok(120, 5000)], ['NFO:PE25000', { kind: 'throttled', retryAfterMs: 1000 }]]),
      greeks: null,
      baseline: new Map(),
    });
    expect(quotedLegs).toBe(1);
    expect(entries[0].peData).toBeNull();
    expect(entries[0].ceData).toEqual(expect.objectContaining({ ltp: 120, iv: 0, delta: 0 }));
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @td/api test -- chain-math.spec`
Expected: FAIL: `Cannot find module './chain-math'`.

- [ ] **Step 3: Implement `chain/chain-math.ts`**

```ts
import type { OptionData, OptionsChainEntry } from '@td/shared/types';
import type { QuoteOutcome } from '../quote-batcher';
import { refKey } from '../hub.types';
import type { ChainContract, OptionGreekRow, OptionSide } from './chain.types';
import { expiryCloseAt } from './chain-dates';

export const RISK_FREE_RATE = 0.065;
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

export interface GreeksMath {
  calculateIV(price: number, spot: number, strike: number, t: number, rate: number, type: OptionSide): number;
  calculateGreeks(spot: number, strike: number, t: number, rate: number, iv: number, type: OptionSide): {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
  };
}

/** `n` strikes each side of the listed strike nearest `centre` (median strike when null); both sides of each. */
export function pickStrikes(contracts: readonly ChainContract[], centre: number | null, n: number): ChainContract[] {
  const listed = [...new Set(contracts.map((c) => c.strike))].sort((a, b) => a - b);
  if (listed.length === 0) return [];
  let idx = Math.floor((listed.length - 1) / 2);
  if (centre !== null && centre > 0) {
    let best = Infinity;
    listed.forEach((s, i) => {
      const d = Math.abs(s - centre);
      if (d < best) {
        best = d;
        idx = i;
      }
    });
  }
  const keep = new Set(listed.slice(Math.max(0, idx - n), idx + n + 1));
  return contracts.filter((c) => keep.has(c.strike));
}

export interface AssembleInput {
  contracts: readonly ChainContract[];
  quotes: ReadonlyMap<string, QuoteOutcome>;
  greeks: readonly OptionGreekRow[] | null;
  baseline: ReadonlyMap<string, number>;
  spot: number | null;
  expiry: string;
  exchange: string;
  now: number;
  math: GreeksMath;
}

/** Contracts + one quote call + Greeks + the OI baseline → the shared chain shape, strikes ascending. */
export function assembleEntries(i: AssembleInput): { entries: OptionsChainEntry[]; greeks: 'broker' | 'local'; quotedLegs: number } {
  const t = Math.max(0, (expiryCloseAt(i.expiry, i.exchange).getTime() - i.now) / YEAR_MS);
  const rows = new Map((i.greeks ?? []).map((g) => [`${g.strike}:${g.optionType}`, g]));
  const byStrike = new Map<number, OptionsChainEntry>();
  let usedLocal = false;
  let quotedLegs = 0;

  for (const c of i.contracts) {
    const entry = byStrike.get(c.strike) ?? { strikePrice: c.strike, expiryDate: i.expiry, ceData: null, peData: null };
    byStrike.set(c.strike, entry);
    const q = i.quotes.get(refKey(c.ref));
    if (q?.kind !== 'ok') continue;
    quotedLegs++;
    const tick = q.tick;
    const oi = tick.oi ?? 0;
    const base = i.baseline.get(c.instrumentId);
    const row = rows.get(`${c.strike}:${c.optionType}`);
    let g = { iv: 0, delta: 0, gamma: 0, theta: 0, vega: 0 };
    if (row && (row.iv > 0 || row.delta !== 0)) {
      g = { iv: row.iv, delta: row.delta, gamma: row.gamma, theta: row.theta, vega: row.vega };
    } else if (i.spot !== null && i.spot > 0 && tick.ltp > 0 && t > 0) {
      usedLocal = true;
      const iv = i.math.calculateIV(tick.ltp, i.spot, c.strike, t, RISK_FREE_RATE, c.optionType);
      const greeks = iv > 0 ? i.math.calculateGreeks(i.spot, c.strike, t, RISK_FREE_RATE, iv, c.optionType) : { delta: 0, gamma: 0, theta: 0, vega: 0 };
      g = { iv: Math.round(iv * 10000) / 100, ...greeks };
    }
    const leg: OptionData = {
      ltp: tick.ltp,
      oi,
      oiChange: base === undefined || tick.oi === undefined ? null : oi - base,
      volume: tick.volume ?? 0,
      ...g,
      bidPrice: tick.depth?.bids[0]?.price ?? 0,
      askPrice: tick.depth?.asks[0]?.price ?? 0,
      token: c.ref.token,
      lotSize: c.lotSize,
    };
    if (c.optionType === 'CE') entry.ceData = leg;
    else entry.peData = leg;
  }

  const entries = [...byStrike.values()].sort((a, b) => a.strikePrice - b.strikePrice);
  return { entries, greeks: usedLocal ? 'local' : 'broker', quotedLegs };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @td/api test -- chain-math.spec`
Expected: PASS. (The expected object's key order does not matter to `toEqual`.)

- [ ] **Step 5: Commit**

Pathspecs: `chain-math.ts`, `chain-math.spec.ts`. Message: `feat(market-hub): chain math — strike window and leg assembly with OI baseline and Greeks`.

---

### Task 7: `ChainBuilder`: one governed chain build

**Files:**
- Modify: `apps/api/src/modules/market-hub/chain/chain.types.ts` (append `ChainUnavailable`)
- Create: `apps/api/src/modules/market-hub/chain/chain-builder.ts`
- Test: `apps/api/src/modules/market-hub/chain/chain-builder.spec.ts`

**Interfaces:**
- Consumes: `ChainRepo` (Task 5), `pickStrikes`, `assembleEntries`, `GreeksMath` (Task 6), `HubEngine.quoteNow` / `greeks`
  signatures (Task 4), `GovResult` (`governor.ts`), `istDay`, `istMidnight` (`candles/trading-calendar.ts`).
- Produces:

```ts
// chain.types.ts
export type ChainUnavailable = 'no-contracts' | 'throttled' | 'busy' | 'no-session' | 'error';

// chain-builder.ts
export interface ChainBuilderDeps {
  repo: ChainRepo;
  quoteNow(refs: readonly InstrumentRef[], lane: Lane): Promise<Map<string, QuoteOutcome>>;
  greeks(name: string, expiry: string, lane: Lane): Promise<GovResult<OptionGreekRow[]>>;
  /** The underlying's price when the PriceBook has it fresh, else null. */
  bookSpot(ref: InstrumentRef): number | null;
  math: GreeksMath;
  now?: () => number;
}
export type BuildOutcome = { kind: 'ok'; chain: HubChain } | { kind: 'unavailable'; reason: ChainUnavailable };
export class ChainBuilder {
  constructor(d: ChainBuilderDeps);
  contracts(underlying: string, expiry: string): Promise<ChainContract[]>;   // cached per IST day
  expiries(underlying: string): Promise<string[]>;                           // cached per IST day
  contractFor(underlying: string, expiry: string, strike: number, type: OptionSide): Promise<ChainContract | null>;
  build(underlying: string, expiry: string, opts: { lane: Lane; strikesAround: number; hintSpot?: number | null }): Promise<BuildOutcome>;
  readonly baselineFailures: number;
}
```

- [ ] **Step 1: Write the failing tests**

`chain/chain-builder.spec.ts`:

```ts
import { GreeksCalculatorService } from '../../options-chain/services/greeks-calculator.service';
import type { QuoteOutcome } from '../quote-batcher';
import { refKey, type InstrumentRef } from '../hub.types';
import { MemoryChainRepo } from '../testing/memory-chain-repo';
import type { ChainContract } from './chain.types';
import { ChainBuilder, type ChainBuilderDeps } from './chain-builder';

const NIFTY: InstrumentRef = { exchange: 'NSE', token: '99926000', symbol: 'Nifty 50' };
const E = '2026-10-13';
const contract = (strike: number, side: 'CE' | 'PE'): ChainContract => ({
  instrumentId: `id-${side}${strike}`,
  ref: { exchange: 'NFO', token: `${side}${strike}`, symbol: `NIFTY${strike}${side}` },
  strike,
  optionType: side,
  lotSize: 75,
});
function repoWithNifty() {
  const repo = new MemoryChainRepo();
  const rows: ChainContract[] = [];
  for (let s = 24000; s <= 26000; s += 50) rows.push(contract(s, 'CE'), contract(s, 'PE'));
  repo.addContracts('NIFTY', E, rows);
  repo.addContracts('NIFTY', '2026-10-20', rows.map((c) => ({ ...c, instrumentId: `w2-${c.instrumentId}` })));
  repo.underlyings.set('NIFTY', NIFTY);
  return repo;
}
const tick = (ltp: number, oi = 1000): QuoteOutcome => ({
  kind: 'ok',
  tick: { token: 't', symbol: 't', ltp, open: 0, high: 0, low: 0, close: 0, volume: 1, oi, timestamp: new Date() },
});

function builder(over: Partial<ChainBuilderDeps> = {}) {
  let now = Date.parse('2026-10-12T05:00:00Z');
  const quoteCalls: InstrumentRef[][] = [];
  const greekCalls: string[] = [];
  const deps: ChainBuilderDeps = {
    repo: repoWithNifty(),
    quoteNow: async (refs) => {
      quoteCalls.push([...refs]);
      return new Map(refs.map((r) => [refKey(r), r.exchange === 'NSE' ? tick(25010) : tick(100)] as const));
    },
    greeks: async (name, expiry) => {
      greekCalls.push(`${name}:${expiry}`);
      return { kind: 'ok', value: [] };
    },
    bookSpot: () => 25010,
    math: new GreeksCalculatorService(),
    now: () => now,
    ...over,
  };
  return { b: new ChainBuilder(deps), deps, quoteCalls, greekCalls, advance: (ms: number) => (now += ms) };
}

describe('ChainBuilder', () => {
  it('builds ±N strikes around the book spot with one quote call for every leg and no spot ref', async () => {
    const { b, quoteCalls } = builder();
    const out = await b.build('nifty', E, { lane: 1, strikesAround: 2 });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.chain).toEqual(expect.objectContaining({ underlying: 'NIFTY', expiry: E, exchange: 'NFO', spot: 25010 }));
    expect(out.chain.entries.map((e) => e.strikePrice)).toEqual([24900, 24950, 25000, 25050, 25100]);
    expect(quoteCalls).toHaveLength(1);
    expect(quoteCalls[0]).toHaveLength(10);
    expect(quoteCalls[0].some((r) => r.exchange === 'NSE')).toBe(false);
  });

  it('quotes the underlying with the legs when the book has no fresh spot, and takes spot from it', async () => {
    const { b, quoteCalls } = builder({ bookSpot: () => null });
    const out = await b.build('NIFTY', E, { lane: 1, strikesAround: 1, hintSpot: 25000 });
    expect(quoteCalls[0].filter((r) => r.exchange === 'NSE')).toEqual([NIFTY]);
    expect(out.kind === 'ok' && out.chain.spot).toBe(25010);
  });

  it('no contracts is unavailable without any broker call', async () => {
    const { b, quoteCalls, greekCalls } = builder();
    await expect(b.build('NOSUCH', E, { lane: 1, strikesAround: 2 })).resolves.toEqual({ kind: 'unavailable', reason: 'no-contracts' });
    expect(quoteCalls).toHaveLength(0);
    expect(greekCalls).toHaveLength(0);
  });

  it('every leg throttled is unavailable: throttled; every leg busy is busy', async () => {
    const throttled = builder({ quoteNow: async (refs) => new Map(refs.map((r) => [refKey(r), { kind: 'throttled', retryAfterMs: 1000 }] as const)) });
    await expect(throttled.b.build('NIFTY', E, { lane: 1, strikesAround: 1 })).resolves.toEqual({ kind: 'unavailable', reason: 'throttled' });
    const busy = builder({ quoteNow: async (refs) => new Map(refs.map((r) => [refKey(r), { kind: 'busy' }] as const)) });
    await expect(busy.b.build('NIFTY', E, { lane: 1, strikesAround: 1 })).resolves.toEqual({ kind: 'unavailable', reason: 'busy' });
  });

  it('a throttled optionGreek still builds the chain, with Greeks computed locally', async () => {
    const { b } = builder({ greeks: async () => ({ kind: 'throttled', retryAfterMs: 1000 }) });
    const out = await b.build('NIFTY', E, { lane: 1, strikesAround: 1 });
    expect(out.kind === 'ok' && out.chain.greeks).toBe('local');
  });

  it('caches Greeks for 60 s per underlying+expiry, and contracts per IST day', async () => {
    const { b, deps, greekCalls, advance } = builder();
    await b.build('NIFTY', E, { lane: 1, strikesAround: 1 });
    advance(30_000);
    await b.build('NIFTY', E, { lane: 1, strikesAround: 1 });
    expect(greekCalls).toHaveLength(1);
    advance(31_000);
    await b.build('NIFTY', E, { lane: 1, strikesAround: 1 });
    expect(greekCalls).toHaveLength(2);
    expect((deps.repo as MemoryChainRepo).contractCalls).toBe(1);
  });

  it('a failed baseline read still builds, with oiChange null, and is counted', async () => {
    const repo = repoWithNifty();
    repo.failBaseline = true;
    const { b } = builder({ repo });
    const out = await b.build('NIFTY', E, { lane: 1, strikesAround: 0 });
    expect(out.kind === 'ok' && out.chain.entries[0].ceData?.oiChange).toBeNull();
    expect(b.baselineFailures).toBe(1);
  });

  it('expiries come from the repo from today (IST), and contractFor matches strike and side exactly', async () => {
    const { b } = builder();
    await expect(b.expiries('NIFTY')).resolves.toEqual([E, '2026-10-20']);
    await expect(b.contractFor('NIFTY', E, 25000, 'PE')).resolves.toEqual(expect.objectContaining({ strike: 25000, optionType: 'PE' }));
    await expect(b.contractFor('NIFTY', E, 25025, 'PE')).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @td/api test -- chain-builder.spec`
Expected: FAIL: `Cannot find module './chain-builder'`.

- [ ] **Step 3: Implement**

Append to `chain.types.ts`:

```ts
export type ChainUnavailable = 'no-contracts' | 'throttled' | 'busy' | 'no-session' | 'error';
```

`chain/chain-builder.ts`:

```ts
import { istDay, istMidnight } from '../candles/trading-calendar';
import type { GovResult } from '../governor';
import type { InstrumentRef, Lane } from '../hub.types';
import { refKey } from '../hub.types';
import type { QuoteOutcome } from '../quote-batcher';
import type { ChainRepo } from './chain-repository';
import type { ChainContract, ChainUnavailable, HubChain, OptionGreekRow, OptionSide } from './chain.types';
import { assembleEntries, pickStrikes, type GreeksMath } from './chain-math';

const GREEKS_TTL_MS = 60_000;
const MAX_KEYS = 200;

export interface ChainBuilderDeps {
  repo: ChainRepo;
  quoteNow(refs: readonly InstrumentRef[], lane: Lane): Promise<Map<string, QuoteOutcome>>;
  greeks(name: string, expiry: string, lane: Lane): Promise<GovResult<OptionGreekRow[]>>;
  bookSpot(ref: InstrumentRef): number | null;
  math: GreeksMath;
  now?: () => number;
}

export type BuildOutcome = { kind: 'ok'; chain: HubChain } | { kind: 'unavailable'; reason: ChainUnavailable };

interface DayCached<T> {
  day: string;
  value: T;
}

/** Bounded map: drop everything when it grows past MAX_KEYS (keys are per underlying+expiry; a day has few). */
function boundedSet<K, V>(m: Map<K, V>, k: K, v: V): void {
  if (m.size >= MAX_KEYS && !m.has(k)) m.clear();
  m.set(k, v);
}

/**
 * Builds ONE chain: DB contracts → spot (PriceBook, else in the same quote call) → ±N strikes →
 * one batched FULL quote for every leg + one optionGreek (60 s cache) + the previous-session OI
 * baseline (per day) → HubChain. Never throws.
 */
export class ChainBuilder {
  private readonly contractCache = new Map<string, DayCached<ChainContract[]>>();
  private readonly expiryCache = new Map<string, DayCached<string[]>>();
  private readonly underlyingCache = new Map<string, DayCached<InstrumentRef | null>>();
  private readonly baselineCache = new Map<string, DayCached<Map<string, number>>>();
  private readonly greekCache = new Map<string, { at: number; rows: OptionGreekRow[] }>();
  private baselineFailuresCount = 0;

  constructor(private readonly d: ChainBuilderDeps) {}

  get baselineFailures(): number {
    return this.baselineFailuresCount;
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private today(): string {
    return istDay(this.now());
  }

  async contracts(underlying: string, expiry: string): Promise<ChainContract[]> {
    const key = `${underlying.toUpperCase()}:${expiry}`;
    const day = this.today();
    const hit = this.contractCache.get(key);
    if (hit && hit.day === day) return hit.value;
    const value = await this.d.repo.contracts(underlying.toUpperCase(), expiry);
    boundedSet(this.contractCache, key, { day, value });
    return value;
  }

  async expiries(underlying: string): Promise<string[]> {
    const u = underlying.toUpperCase();
    const day = this.today();
    const hit = this.expiryCache.get(u);
    if (hit && hit.day === day) return hit.value;
    const value = await this.d.repo.expiries(u, day);
    boundedSet(this.expiryCache, u, { day, value });
    return value;
  }

  async contractFor(underlying: string, expiry: string, strike: number, type: OptionSide): Promise<ChainContract | null> {
    const all = await this.contracts(underlying, expiry);
    return all.find((c) => c.optionType === type && Math.abs(c.strike - strike) < 0.01) ?? null;
  }

  async build(
    underlying: string,
    expiry: string,
    opts: { lane: Lane; strikesAround: number; hintSpot?: number | null },
  ): Promise<BuildOutcome> {
    const u = underlying.toUpperCase();
    try {
      const all = await this.contracts(u, expiry);
      if (all.length === 0) return { kind: 'unavailable', reason: 'no-contracts' };
      const exchange = all[0].ref.exchange;
      const uref = await this.underlyingRef(u, exchange, expiry);
      let spot = uref ? this.d.bookSpot(uref) : null;
      const picked = pickStrikes(all, spot ?? opts.hintSpot ?? null, opts.strikesAround);
      const refs = picked.map((c) => c.ref);
      if (spot === null && uref) refs.push(uref);

      const [quotes, greeks, baseline] = await Promise.all([
        this.d.quoteNow(refs, opts.lane),
        this.greeksFor(u, expiry, opts.lane),
        this.baselineFor(`${u}:${expiry}`, all),
      ]);

      const legOutcomes = picked.map((c) => quotes.get(refKey(c.ref)));
      if (!legOutcomes.some((o) => o?.kind === 'ok')) {
        const reason: ChainUnavailable = legOutcomes.some((o) => o?.kind === 'throttled')
          ? 'throttled'
          : legOutcomes.some((o) => o?.kind === 'busy')
            ? 'busy'
            : 'error';
        return { kind: 'unavailable', reason };
      }
      if (spot === null && uref) {
        const s = quotes.get(refKey(uref));
        spot = s?.kind === 'ok' && s.tick.ltp > 0 ? s.tick.ltp : null;
      }
      const at = this.now();
      const assembled = assembleEntries({
        contracts: picked,
        quotes,
        greeks,
        baseline,
        spot,
        expiry,
        exchange,
        now: at,
        math: this.d.math,
      });
      return {
        kind: 'ok',
        chain: { underlying: u, expiry, exchange, spot, at, greeks: assembled.greeks, entries: assembled.entries },
      };
    } catch {
      return { kind: 'unavailable', reason: 'error' };
    }
  }

  private async underlyingRef(u: string, exchange: InstrumentRef['exchange'], expiry: string): Promise<InstrumentRef | null> {
    const key = `${u}:${expiry}`;
    const day = this.today();
    const hit = this.underlyingCache.get(key);
    if (hit && hit.day === day) return hit.value;
    const value = await this.d.repo.underlyingRef(u, exchange, expiry);
    boundedSet(this.underlyingCache, key, { day, value });
    return value;
  }

  /**
   * Broker rows within 60 s, else one governed call. A failure is not cached (next build retries);
   * an empty answer IS cached (a real "none" — do not re-ask every build). No rows → null (local Greeks).
   */
  private async greeksFor(u: string, expiry: string, lane: Lane): Promise<OptionGreekRow[] | null> {
    const key = `${u}:${expiry}`;
    const hit = this.greekCache.get(key);
    if (hit && this.now() - hit.at < GREEKS_TTL_MS) return hit.rows.length ? hit.rows : null;
    const res = await this.d.greeks(u, expiry, lane);
    if (res.kind !== 'ok') return null;
    boundedSet(this.greekCache, key, { at: this.now(), rows: res.value });
    return res.value.length ? res.value : null;
  }

  /** Every contract of the expiry, once per IST day; a failure is not cached and gives "no baseline". */
  private async baselineFor(key: string, all: readonly ChainContract[]): Promise<Map<string, number>> {
    const day = this.today();
    const hit = this.baselineCache.get(key);
    if (hit && hit.day === day) return hit.value;
    try {
      const value = await this.d.repo.baseline(all.map((c) => c.instrumentId), new Date(istMidnight(day)));
      boundedSet(this.baselineCache, key, { day, value });
      return value;
    } catch {
      this.baselineFailuresCount++;
      return new Map();
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @td/api test -- chain-builder.spec chain-math.spec`
Expected: PASS.

- [ ] **Step 5: Commit**

Pathspecs: `chain.types.ts`, `chain-builder.ts`, `chain-builder.spec.ts`. Message:
`feat(market-hub): ChainBuilder — one governed chain build with 60 s Greeks and a daily OI baseline`.

---

### Task 8: `ChainService` (the hub's `HubChains`) and its wiring

**Files:**
- Modify: `apps/api/src/modules/market-hub/chain/chain.types.ts` (append `ChainResult`, `ChainRequest`, `HubChains`, `ChainStatus`)
- Create: `apps/api/src/modules/market-hub/chain/chain-service.ts`
- Test: `apps/api/src/modules/market-hub/chain/chain-service.spec.ts`
- Modify: `apps/api/src/modules/market-hub/hub-engine.ts` (deps, `chains` field, `start`/`stop`, `setPositions`, `status().chain`)
- Modify: `apps/api/src/modules/market-hub/hub-prices.ts` (`HubPrices.chains?`, `engineHubPrices`)
- Modify: `apps/api/src/modules/market-hub/market-hub.service.ts` (chain deps from config)
- Test: `apps/api/src/modules/market-hub/hub-engine.spec.ts`

**Interfaces:**
- Consumes: `ChainBuilder` (Task 7), `ChainRepo` (Task 5), `HubEngine.quoteNow` / `greeks` / `price` / `watchMany` (Task 4 + existing), `SessionClock.isOpen`.
- Produces:

```ts
// chain.types.ts
export type ChainResult =
  | { kind: 'fresh'; chain: HubChain }
  | { kind: 'stale'; chain: HubChain; ageMs: number }
  | { kind: 'market-closed'; chain: HubChain }
  | { kind: 'unavailable'; reason: ChainUnavailable };
export interface ChainRequest {
  /** A screen (GET /api/options/chain): renews the 2-min refresh watch and marks the underlying viewed today. */
  screen?: boolean;
}
export interface HubChains {
  chain(underlying: string, expiry: string, opts?: ChainRequest): Promise<ChainResult>;
  expiries(underlying: string): Promise<string[]>;
  optionLtp(underlying: string, expiry: string, strike: number, type: OptionSide): Promise<number | null>;
}
export interface ChainStatus {
  builds: number;
  buildP95Ms: number;
  cacheHits: number;
  greeksLocal: number;
  unavailable: Record<ChainUnavailable, number>;
  baselineFailures: number;
  watched: number;
  held: number;
  viewedToday: number;
  snapshot: { enabled: boolean; rowsToday: number; failures: number; lastAt: Record<string, number> };
}

// chain-service.ts
export interface ChainServiceDeps {
  builder: Pick<ChainBuilder, 'contracts' | 'expiries' | 'contractFor' | 'build' | 'baselineFailures'>;
  repo: ChainRepo;
  clock: Pick<SessionClock, 'isOpen'>;
  strikesAround: number;
  watchContract(ref: InstrumentRef): void;
  priceOf(ref: InstrumentRef): PriceResult;
  quoteNow(refs: readonly InstrumentRef[], lane: Lane): Promise<Map<string, QuoteOutcome>>;
  log?: (message: string) => void;
  now?: () => number;
}
export class ChainService implements HubChains {
  // + setHeld(refs), refreshTick(now), start(), stop(), status(), pruneOi(before)
}
// hub-engine.ts
HubEngineDeps.chain?: { repo: ChainRepo; math: GreeksMath; strikesAround: number; coreUnderlyings: readonly string[]; snapshots: boolean; log?: (m: string) => void };
HubEngine.chains: ChainService | null;
HubStatus.chain: ChainStatus | null;
// hub-prices.ts
HubPrices.chains?: HubChains;
```

- [ ] **Step 1: Write the failing tests**

`chain/chain-service.spec.ts`:

```ts
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SessionClock } from '../session-clock';
import { MemoryChainRepo } from '../testing/memory-chain-repo';
import type { BuildOutcome } from './chain-builder';
import type { ChainContract, HubChain } from './chain.types';
import { ChainService, type ChainServiceDeps } from './chain-service';

const IST = (local: string) => Date.parse(`${local}Z`) - 5.5 * 3600_000;
const E = '2026-10-13';
const nfo = (strike: number): ChainContract => ({ instrumentId: `i${strike}`, ref: { exchange: 'NFO', token: `T${strike}`, symbol: `N${strike}` }, strike, optionType: 'CE', lotSize: 75 });
const mcx = (strike: number): ChainContract => ({ instrumentId: `m${strike}`, ref: { exchange: 'MCX', token: `M${strike}`, symbol: `C${strike}` }, strike, optionType: 'CE', lotSize: 100 });
const chainAt = (underlying: string, at: number, exchange: 'NFO' | 'MCX' = 'NFO'): HubChain => ({
  underlying, expiry: E, exchange, spot: 25000, at, greeks: 'broker', entries: [{ strikePrice: 25000, expiryDate: E, ceData: null, peData: null }],
});

function service(start: string, over: Partial<ChainServiceDeps> = {}) {
  let now = IST(start);
  const builds: Array<{ u: string; lane: number }> = [];
  let next: (u: string) => BuildOutcome = (u) => ({ kind: 'ok', chain: chainAt(u, now, u === 'CRUDEOIL' ? 'MCX' : 'NFO') });
  const repo = new MemoryChainRepo();
  const contracts: Record<string, ChainContract[]> = { NIFTY: [nfo(25000)], CRUDEOIL: [mcx(6000)] };
  const deps: ChainServiceDeps = {
    builder: {
      contracts: async (u) => contracts[u] ?? [],
      expiries: async (u) => (contracts[u] ? [E] : []),
      contractFor: async (u, _e, strike, type) => (contracts[u] ?? []).find((c) => c.strike === strike && c.optionType === type) ?? null,
      build: async (u, _e, o) => {
        builds.push({ u, lane: o.lane });
        return next(u);
      },
      baselineFailures: 0,
    },
    repo,
    clock: new SessionClock({ holidays: MARKET_HOLIDAYS }),
    strikesAround: 20,
    watchContract: jest.fn(),
    priceOf: () => ({ kind: 'unavailable', reason: 'never-priced' }),
    quoteNow: async () => new Map(),
    now: () => now,
    ...over,
  };
  const svc = new ChainService(deps);
  return {
    svc, repo, builds, deps,
    advance: (ms: number) => (now += ms),
    setNext: (f: (u: string) => BuildOutcome) => (next = f),
    now: () => now,
  };
}

describe('ChainService', () => {
  it('builds on an Interactive lane when asked, then serves the cached chain fresh for 15 s', async () => {
    const { svc, builds, advance } = service('2026-10-12T10:00:00');
    expect((await svc.chain('nifty', E)).kind).toBe('fresh');
    advance(10_000);
    expect((await svc.chain('NIFTY', E)).kind).toBe('fresh');
    expect(builds).toEqual([{ u: 'NIFTY', lane: 1 }]);
    advance(6_000);
    await svc.chain('NIFTY', E);
    expect(builds).toHaveLength(2);
    expect(svc.status().cacheHits).toBe(1);
  });

  it('a failed build serves the cached chain as stale with its age', async () => {
    const { svc, advance, setNext } = service('2026-10-12T10:00:00');
    await svc.chain('NIFTY', E);
    advance(20_000);
    setNext(() => ({ kind: 'unavailable', reason: 'throttled' }));
    const r = await svc.chain('NIFTY', E);
    expect(r).toEqual({ kind: 'stale', chain: expect.objectContaining({ underlying: 'NIFTY' }), ageMs: 20_000 });
    expect(svc.status().unavailable.throttled).toBe(1);
  });

  it("falls back to today's stored snapshot as stale, and to unavailable with the build's reason", async () => {
    const { svc, repo, setNext, now } = service('2026-10-12T10:00:00');
    setNext(() => ({ kind: 'unavailable', reason: 'busy' }));
    await expect(svc.chain('NIFTY', E)).resolves.toEqual({ kind: 'unavailable', reason: 'busy' });
    repo.chainSnapshots.push(chainAt('NIFTY', now() - 120_000));
    const r = await svc.chain('NIFTY', E);
    expect(r.kind === 'stale' && r.ageMs).toBe(120_000);
  });

  it('no contracts is unavailable: no-contracts, without a build', async () => {
    const { svc, builds } = service('2026-10-12T10:00:00');
    await expect(svc.chain('NOSUCH', E)).resolves.toEqual({ kind: 'unavailable', reason: 'no-contracts' });
    expect(builds).toHaveLength(0);
  });

  it('a closed venue serves the latest snapshot as market-closed while another venue refreshes', async () => {
    const { svc, repo, builds } = service('2026-10-12T16:00:00'); // NSE closed, MCX open
    repo.chainSnapshots.push(chainAt('NIFTY', IST('2026-10-12T15:30:00')));
    const n = await svc.chain('NIFTY', E);
    expect(n.kind).toBe('market-closed');
    expect(n.kind === 'market-closed' && n.chain.at).toBe(IST('2026-10-12T15:30:00'));
    expect((await svc.chain('CRUDEOIL', E)).kind).toBe('fresh');
    expect(builds.map((b) => b.u)).toEqual(['CRUDEOIL']);
  });

  it('a closed market with no cache and no snapshot builds once, stores it, then serves it', async () => {
    const { svc, repo, builds } = service('2026-10-12T20:00:00'); // NSE closed
    const r = await svc.chain('NIFTY', E);
    expect(r.kind).toBe('market-closed');
    await svc.chain('NIFTY', E);
    expect(builds).toHaveLength(1);
    await new Promise((res) => setImmediate(res));
    expect(repo.chainSnapshots).toHaveLength(1);
  });

  it('refreshes screen-watched and held chains every 10 s on the Routine lane, until the screen watch expires', async () => {
    const { svc, builds, advance, repo, now } = service('2026-10-12T10:00:00');
    await svc.chain('NIFTY', E, { screen: true });
    advance(10_000);
    await svc.refreshTick(now());
    expect(builds.map((b) => b.lane)).toEqual([1, 2]);
    advance(121_000);
    await svc.refreshTick(now());
    expect(builds).toHaveLength(2); // expired, no refresh
    repo.heldInfo.set('NFO:HELD1', { name: 'NIFTY', expiry: E });
    await svc.setHeld([{ exchange: 'NFO', token: 'HELD1', symbol: 'NIFTY25000CE' }]);
    advance(10_000);
    await svc.refreshTick(now());
    expect(builds).toHaveLength(3);
    expect(svc.status().held).toBe(1);
  });

  it('a hot-path consumer (no screen flag) gets a build but no standing refresh', async () => {
    const { svc, builds, advance, now } = service('2026-10-12T10:00:00');
    await svc.chain('NIFTY', E);
    advance(10_000);
    await svc.refreshTick(now());
    expect(builds).toHaveLength(1);
    expect(svc.status().viewedToday).toBe(0);
  });

  it('merges concurrent builds for the same chain', async () => {
    const { svc, builds } = service('2026-10-12T10:00:00');
    await Promise.all([svc.chain('NIFTY', E), svc.chain('NIFTY', E), svc.chain('NIFTY', E)]);
    expect(builds).toHaveLength(1);
  });

  it('optionLtp watches the contract, answers from the book, else quotes it now', async () => {
    const watchContract = jest.fn();
    const quoteNow = jest.fn(async () => new Map([['NFO:T25000', { kind: 'ok' as const, tick: { token: 'T25000', symbol: 'x', ltp: 130.5, open: 0, high: 0, low: 0, close: 0, volume: 0, timestamp: new Date() } }]]));
    const { svc } = service('2026-10-12T10:00:00', { watchContract, quoteNow });
    await expect(svc.optionLtp('NIFTY', E, 25000, 'CE')).resolves.toBe(130.5);
    expect(watchContract).toHaveBeenCalledWith({ exchange: 'NFO', token: 'T25000', symbol: 'N25000' });
    await expect(svc.optionLtp('NIFTY', E, 25050, 'CE')).resolves.toBeNull();
  });
});
```

Append to `hub-engine.spec.ts`:

```ts
  it('with chain deps the engine exposes chains, reports chain status, and marks held positions', async () => {
    const { MemoryChainRepo } = await import('./testing/memory-chain-repo');
    const { GreeksCalculatorService } = await import('../options-chain/services/greeks-calculator.service');
    const repo = new MemoryChainRepo();
    repo.heldInfo.set('NFO:35001', { name: 'NIFTY', expiry: '2026-10-27' });
    const e = new HubEngine({
      broker: new FakeBroker(),
      clock: new SessionClock({ holidays: MARKET_HOLIDAYS }),
      cap: 50,
      defaults: [NIFTY],
      chain: { repo, math: new GreeksCalculatorService(), strikesAround: 20, coreUnderlyings: [], snapshots: false },
    });
    await e.start();
    await e.setPositions([POS]);
    await jest.advanceTimersByTimeAsync(0);
    expect(e.chains).not.toBeNull();
    expect(e.status().chain).toEqual(expect.objectContaining({ builds: 0, held: 1 }));
    await expect(e.chains!.chain('NOSUCH', '2026-10-13')).resolves.toEqual({ kind: 'unavailable', reason: 'no-contracts' });
    e.stop();
  });

  it('without chain deps there are no chains and status().chain is null', async () => {
    const { e } = engine();
    expect(e.chains).toBeNull();
    expect(e.status().chain).toBeNull();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @td/api test -- chain-service.spec hub-engine.spec`
Expected: FAIL: `Cannot find module './chain-service'`; `e.chains` undefined.

- [ ] **Step 3: Append the types to `chain.types.ts`** (exactly the block under **Produces** above).

- [ ] **Step 4: Implement `chain/chain-service.ts`**

```ts
import { istDay } from '../candles/trading-calendar';
import type { SessionClock } from '../session-clock';
import { LANE, refKey, type HubExchange, type InstrumentRef, type Lane, type PriceResult } from '../hub.types';
import type { QuoteOutcome } from '../quote-batcher';
import type { BuildOutcome, ChainBuilder } from './chain-builder';
import type { ChainRepo } from './chain-repository';
import type { ChainRequest, ChainResult, ChainStatus, ChainUnavailable, HubChain, HubChains, OptionSide } from './chain.types';

export const CHAIN_FRESH_MS = 15_000;
export const CHAIN_REFRESH_MS = 10_000;
export const SCREEN_WATCH_MS = 120_000;
const MAX_CACHE = 100;
const BUILD_SAMPLES = 200;
const REASONS: ChainUnavailable[] = ['no-contracts', 'throttled', 'busy', 'no-session', 'error'];

export interface ChainServiceDeps {
  builder: Pick<ChainBuilder, 'contracts' | 'expiries' | 'contractFor' | 'build' | 'baselineFailures'>;
  repo: ChainRepo;
  clock: Pick<SessionClock, 'isOpen'>;
  strikesAround: number;
  watchContract(ref: InstrumentRef): void;
  priceOf(ref: InstrumentRef): PriceResult;
  quoteNow(refs: readonly InstrumentRef[], lane: Lane): Promise<Map<string, QuoteOutcome>>;
  log?: (message: string) => void;
  now?: () => number;
}

const keyOf = (u: string, e: string) => `${u.toUpperCase()}:${e}`;
const splitKey = (k: string): [string, string] => {
  const i = k.lastIndexOf(':');
  return [k.slice(0, i), k.slice(i + 1)];
};

/**
 * The hub's option chains (spec §3): a 15 s cache, merged builds, a 10 s Routine refresh for chains a
 * screen or a held position watches, the closed-market rule (latest snapshot, labelled), and the
 * stale/unavailable fallbacks. Never throws to a caller.
 */
export class ChainService implements HubChains {
  private readonly cache = new Map<string, HubChain>();
  private readonly inflight = new Map<string, Promise<BuildOutcome>>();
  private readonly screenWatch = new Map<string, number>();
  private held = new Set<string>();
  private viewed = { day: '', keys: new Set<string>() };
  private readonly warned = new Set<string>();
  private readonly buildMs: number[] = [];
  private builds = 0;
  private cacheHits = 0;
  private greeksLocal = 0;
  private readonly unavailable = Object.fromEntries(REASONS.map((r) => [r, 0])) as Record<ChainUnavailable, number>;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: ChainServiceDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refreshTick(this.now()), CHAIN_REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async chain(underlying: string, expiry: string, opts: ChainRequest = {}): Promise<ChainResult> {
    const u = underlying.toUpperCase();
    const key = keyOf(u, expiry);
    const now = this.now();
    if (opts.screen) {
      this.screenWatch.set(key, now + SCREEN_WATCH_MS);
      this.markViewed(key, now);
    }
    const exchange = await this.venue(u, expiry);
    if (exchange === 'error') return this.fail(key, 'error');
    if (!exchange) return this.fail(key, 'no-contracts');
    const cached = this.cache.get(key);

    if (!this.d.clock.isOpen(exchange, new Date(now))) return this.closed(key, u, expiry, exchange, cached);

    if (cached && now - cached.at <= CHAIN_FRESH_MS) {
      this.cacheHits++;
      return { kind: 'fresh', chain: cached };
    }
    const out = await this.build(key, u, expiry, LANE.INTERACTIVE);
    if (out.kind === 'ok') return { kind: 'fresh', chain: out.chain };
    const prior = cached ?? (await this.snapshotToday(u, expiry, exchange, now));
    if (prior) return { kind: 'stale', chain: prior, ageMs: now - prior.at };
    return { kind: 'unavailable', reason: out.reason }; // counted and logged by build()
  }

  async expiries(underlying: string): Promise<string[]> {
    try {
      return await this.d.builder.expiries(underlying);
    } catch (err) {
      this.warnOnce(`expiries:${underlying}`, `expiries for ${underlying} failed: ${(err as Error)?.message ?? err}`);
      return [];
    }
  }

  async optionLtp(underlying: string, expiry: string, strike: number, type: OptionSide): Promise<number | null> {
    try {
      const c = await this.d.builder.contractFor(underlying, expiry, strike, type);
      if (!c) return null;
      this.d.watchContract(c.ref);
      const r = this.d.priceOf(c.ref);
      if ((r.kind === 'fresh' || r.kind === 'market-closed') && r.price.ltp > 0) return r.price.ltp;
      const q = (await this.d.quoteNow([c.ref], LANE.INTERACTIVE)).get(refKey(c.ref));
      return q?.kind === 'ok' && q.tick.ltp > 0 ? q.tick.ltp : null;
    } catch {
      return null;
    }
  }

  /** Held option contracts → their chains (held expiry + the underlying's nearest), refreshed while held. */
  async setHeld(refs: readonly InstrumentRef[]): Promise<void> {
    try {
      const info = await this.d.repo.describe(refs);
      const next = new Set<string>();
      for (const { name, expiry } of info) {
        next.add(keyOf(name, expiry));
        const nearest = (await this.expiries(name))[0];
        if (nearest) next.add(keyOf(name, nearest));
      }
      this.held = next;
    } catch (err) {
      this.warnOnce('held', `held-chain lookup failed: ${(err as Error)?.message ?? err}`);
    }
  }

  heldKeys(): string[] {
    return [...this.held];
  }

  viewedKeys(now: number = this.now()): string[] {
    return this.viewed.day === istDay(now) ? [...this.viewed.keys] : [];
  }

  /** Rebuild (Routine lane) every watched chain whose venue is open and whose cache is ≥ 10 s old. */
  async refreshTick(now: number): Promise<void> {
    for (const [k, until] of this.screenWatch) if (until <= now) this.screenWatch.delete(k);
    const keys = new Set([...this.screenWatch.keys(), ...this.held]);
    await Promise.all(
      [...keys].map(async (key) => {
        const [u, e] = splitKey(key);
        const exchange = await this.venue(u, e);
        if (!exchange || exchange === 'error' || !this.d.clock.isOpen(exchange, new Date(now))) return;
        const c = this.cache.get(key);
        if (c && now - c.at < CHAIN_REFRESH_MS) return;
        await this.build(key, u, e, LANE.ROUTINE);
      }),
    );
  }

  /** A chain built within the last 10 s, else one Routine build; null when it cannot be built. */
  async freshChain(underlying: string, expiry: string): Promise<HubChain | null> {
    const key = keyOf(underlying, expiry);
    const c = this.cache.get(key);
    if (c && this.now() - c.at < CHAIN_REFRESH_MS) return c;
    const out = await this.build(key, underlying.toUpperCase(), expiry, LANE.ROUTINE);
    return out.kind === 'ok' ? out.chain : null;
  }

  pruneOi(before: Date): Promise<number> {
    return this.d.repo.pruneOi(before);
  }

  status(): ChainStatus {
    const sorted = [...this.buildMs].sort((a, b) => a - b);
    return {
      builds: this.builds,
      buildP95Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] : 0,
      cacheHits: this.cacheHits,
      greeksLocal: this.greeksLocal,
      unavailable: { ...this.unavailable },
      baselineFailures: this.d.builder.baselineFailures,
      watched: this.screenWatch.size,
      held: this.held.size,
      viewedToday: this.viewedKeys().length,
      snapshot: { enabled: false, rowsToday: 0, failures: 0, lastAt: {} },
    };
  }

  /** The chain's venue from its contracts; null = no contracts; 'error' = the lookup failed. */
  private async venue(u: string, e: string): Promise<HubExchange | null | 'error'> {
    try {
      const cs = await this.d.builder.contracts(u, e);
      return cs.length ? cs[0].ref.exchange : null;
    } catch {
      return 'error';
    }
  }

  private async closed(key: string, u: string, e: string, exchange: HubExchange, cached: HubChain | undefined): Promise<ChainResult> {
    if (cached) return { kind: 'market-closed', chain: cached };
    const snap = await this.d.repo.latestChainSnapshot(u, e, exchange).catch(() => null);
    if (snap) {
      this.remember(key, snap);
      return { kind: 'market-closed', chain: snap };
    }
    // Ruling 4: no snapshot yet (first evening after deploy) → build once and store it.
    const out = await this.build(key, u, e, LANE.INTERACTIVE);
    if (out.kind !== 'ok') return { kind: 'unavailable', reason: out.reason };
    void this.d.repo.writeChainSnapshot(out.chain).catch((err) => this.warnOnce(`snap:${key}`, `closed-market snapshot write failed for ${key}: ${(err as Error)?.message ?? err}`));
    return { kind: 'market-closed', chain: out.chain };
  }

  private async snapshotToday(u: string, e: string, exchange: HubExchange, now: number): Promise<HubChain | null> {
    const snap = await this.d.repo.latestChainSnapshot(u, e, exchange).catch(() => null);
    return snap && istDay(snap.at) === istDay(now) ? snap : null;
  }

  private build(key: string, u: string, e: string, lane: Lane): Promise<BuildOutcome> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const started = this.now();
    const hintSpot = this.cache.get(key)?.spot ?? null;
    const p = this.d.builder
      .build(u, e, { lane, strikesAround: this.d.strikesAround, hintSpot })
      .then((out) => {
        if (out.kind === 'ok') {
          this.builds++;
          this.buildMs.push(this.now() - started);
          if (this.buildMs.length > BUILD_SAMPLES) this.buildMs.shift();
          if (out.chain.greeks === 'local') {
            this.greeksLocal++;
            this.warnOnce(`greeks:${key}`, `optionGreek unavailable for ${key}; Greeks computed locally from LTP`);
          }
          this.remember(key, out.chain);
        } else {
          // Every failed build counts once, whether the caller then gets stale, a snapshot or nothing.
          this.unavailable[out.reason]++;
          this.warnOnce(`${key}:${out.reason}`, `option chain ${key} build failed: ${out.reason}`);
        }
        return out;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private remember(key: string, chain: HubChain): void {
    if (this.cache.size >= MAX_CACHE && !this.cache.has(key)) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
    this.cache.set(key, chain);
  }

  /** Venue-level failures (no contracts, contract lookup error), where no build was attempted. */
  private fail(key: string, reason: ChainUnavailable): ChainResult {
    this.unavailable[reason]++;
    if (reason !== 'no-contracts') this.warnOnce(`${key}:${reason}`, `option chain ${key} unavailable: ${reason}`);
    return { kind: 'unavailable', reason };
  }

  private markViewed(key: string, now: number): void {
    const day = istDay(now);
    if (this.viewed.day !== day) this.viewed = { day, keys: new Set() };
    this.viewed.keys.add(key);
  }

  /** Once per message key per IST day (spec §5: never silent, never a log storm). */
  private warnOnce(key: string, message: string): void {
    const k = `${istDay(this.now())}|${key}`;
    if (this.warned.has(k)) return;
    if (this.warned.size > 1000) this.warned.clear();
    this.warned.add(k);
    this.d.log?.(message);
  }
}
```

- [ ] **Step 5: Wire it into the engine, the seam and the service**

`hub-engine.ts`: import `ChainBuilder` from `./chain/chain-builder`, `ChainService` from
`./chain/chain-service`, `type ChainRepo` from `./chain/chain-repository`, `type GreeksMath` from
`./chain/chain-math`, `type ChainStatus` from `./chain/chain.types`. Add to `HubEngineDeps`:

```ts
  /** M5 option chains + OI snapshots. Absent ⇒ no chains (status().chain null). */
  chain?: {
    repo: ChainRepo;
    math: GreeksMath;
    strikesAround: number;
    coreUnderlyings: readonly string[];
    snapshots: boolean;
    log?: (message: string) => void;
  };
```

Add `chain: ChainStatus | null;` to `HubStatus` (after `candles`). Field and constructor (after the
candles block):

```ts
  readonly chains: ChainService | null;
```

```ts
    if (d.chain) {
      const chainDeps = d.chain;
      const builder = new ChainBuilder({
        repo: chainDeps.repo,
        quoteNow: (refs, lane) => this.quoteNow(refs, lane),
        greeks: (name, expiry, lane) => this.greeks(name, expiry, lane),
        bookSpot: (ref) => {
          const r = this.price(ref, { maxAgeMs: 15_000 });
          return r.kind === 'fresh' ? r.price.ltp : null;
        },
        math: chainDeps.math,
      });
      this.chains = new ChainService({
        builder,
        repo: chainDeps.repo,
        clock: d.clock,
        strikesAround: chainDeps.strikesAround,
        watchContract: (ref) => void this.watchMany([ref], 3, 'chain:ltp', 120_000),
        priceOf: (ref) => this.price(ref, { maxAgeMs: 15_000 }),
        quoteNow: (refs, lane) => this.quoteNow(refs, lane),
        log: chainDeps.log,
      });
    } else {
      this.chains = null;
    }
```

In `start()` after `this.poller.start();` add `this.chains?.start();`. In `stop()` after
`this.poller.stop();` add `this.chains?.stop();`. In `setPositions`, before `await this.feed.reconcile();`
add `void this.chains?.setHeld([...refs]);` (never rejects). In `status()` add
`chain: this.chains?.status() ?? null,` after `candles: this.candleStatus(),`.

`hub-prices.ts`: `import type { HubChains } from './chain/chain.types';`; add to `HubPrices`:

```ts
  /** M5: this session's option chains. Absent when the hub was built without chain deps. */
  chains?: HubChains;
```

and change `engineHubPrices` to take `Pick<HubEngine, 'price' | 'prices' | 'watchMany' | 'unwatchMany' | 'onPrice' | 'chains'>`
and add `...(engine.chains ? { chains: engine.chains } : {}),` to the returned object.

`market-hub.service.ts`: import `{ PrismaChainRepo }` from `./chain/chain-repository` and
`{ GreeksCalculatorService }` from `'../options-chain/services/greeks-calculator.service'`. In
`onModuleInit`, pass to `new HubEngine({ … })`:

```ts
      chain: {
        repo: new PrismaChainRepo(this.prisma),
        math: new GreeksCalculatorService(),
        strikesAround: this.config.get<number>('hub.chainStrikesAround') ?? 20,
        coreUnderlyings: (this.config.get<string>('hub.oiCoreUnderlyings') ?? '')
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
        snapshots: this.config.get<boolean>('hub.oiSnapshotEnabled') !== false,
        log: (m) => this.logger.warn(m),
      },
```

Update the class doc comment's milestone list with: "M5: option chains (HubChains, through
`hubFor(…, 'chain')`) behind HUB_SERVES_CHAIN, and 3-minute OI snapshots behind HUB_OI_SNAPSHOT_ENABLED."

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @td/api test -- chain-service.spec market-hub`
Expected: PASS. If an existing spec asserts the whole `status()` object with `toEqual`, add `chain: null`
to its expectation (hubs without chain deps).

- [ ] **Step 7: Commit**

Pathspecs: `chain.types.ts`, `chain-service.ts`, `chain-service.spec.ts`, `hub-engine.ts`,
`hub-engine.spec.ts`, `hub-prices.ts`, `market-hub.service.ts` (+ any spec Step 6 touched). Message:
`feat(market-hub): ChainService — cached, refreshed, venue-aware option chains on the hub`.

---

### Task 9: OI snapshot job and 30-day prune

**Files:**
- Create: `apps/api/src/modules/market-hub/chain/oi-snapshot-job.ts`
- Test: `apps/api/src/modules/market-hub/chain/oi-snapshot-job.spec.ts`
- Modify: `apps/api/src/modules/market-hub/chain/chain-service.ts` (owns the job: `snapshotTargets`, timer, status)
- Modify: `apps/api/src/modules/market-hub/hub-engine.ts` (pass `coreUnderlyings` / `snapshots` through)
- Modify: `apps/api/src/modules/market-hub/market-hub.service.ts` (`hub-oi-prune` cron)
- Modify: `apps/api/src/modules/health/health-detail.service.ts` (`EXPECTED_JOBS`)
- Test: `apps/api/src/modules/market-hub/market-hub.service.spec.ts`

**Interfaces:**
- Consumes: `ChainService.freshChain`, `.heldKeys()`, `.viewedKeys()`, `.expiries`, builder `contracts` (Task 8);
  `ChainRepo.writeOi`, `.writeChainSnapshot` (Task 5); `SessionClock.isOpen`.
- Produces:

```ts
export const OI_SNAPSHOT_EVERY_MS = 180_000;
export const CHAIN_JSON_EVERY_RUNS = 5;
export interface SnapshotTarget { underlying: string; expiry: string }
export interface OiSnapshotJobDeps {
  targets(now: number): Promise<SnapshotTarget[]>;
  contracts(underlying: string, expiry: string): Promise<ChainContract[]>;
  freshChain(underlying: string, expiry: string): Promise<HubChain | null>;
  repo: Pick<ChainRepo, 'writeOi' | 'writeChainSnapshot'>;
  clock: Pick<SessionClock, 'isOpen'>;
  log?: (m: string) => void;
}
export class OiSnapshotJob {
  constructor(d: OiSnapshotJobDeps);
  tick(now: number): Promise<void>;
  status(now: number): { rowsToday: number; failures: number; lastAt: Record<string, number> };
}
// ChainServiceDeps gains: snapshots?: { core: readonly string[] }  (absent ⇒ job off)
// MarketHubService: export const OI_PRUNE_JOB = 'hub-oi-prune'; @Cron('0 45 2 * * *', { name: OI_PRUNE_JOB, timeZone: 'Asia/Kolkata' }) pruneOiSnapshots()
```

- [ ] **Step 1: Write the failing tests**

`chain/oi-snapshot-job.spec.ts`:

```ts
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SessionClock } from '../session-clock';
import { MemoryChainRepo } from '../testing/memory-chain-repo';
import type { ChainContract, HubChain } from './chain.types';
import { OiSnapshotJob, type OiSnapshotJobDeps } from './oi-snapshot-job';

const IST = (local: string) => Date.parse(`${local}Z`) - 5.5 * 3600_000;
const E = '2026-10-13';
const ce: ChainContract = { instrumentId: 'i-ce', ref: { exchange: 'NFO', token: 'T1', symbol: 'N25000CE' }, strike: 25000, optionType: 'CE', lotSize: 75 };
const pe: ChainContract = { instrumentId: 'i-pe', ref: { exchange: 'NFO', token: 'T2', symbol: 'N25000PE' }, strike: 25000, optionType: 'PE', lotSize: 75 };
const leg = (token: string, oi: number, oiChange: number | null) => ({ ltp: 10, oi, oiChange, volume: 3, iv: 12, delta: 0, gamma: 0, theta: 0, vega: 0, bidPrice: 0, askPrice: 0, token, lotSize: 75 });
const chain = (at: number): HubChain => ({
  underlying: 'NIFTY', expiry: E, exchange: 'NFO', spot: 25000, at, greeks: 'broker',
  entries: [{ strikePrice: 25000, expiryDate: E, ceData: leg('T1', 1000, 50), peData: leg('T2', 2000, null) }],
});

function job(over: Partial<OiSnapshotJobDeps> = {}) {
  const repo = new MemoryChainRepo();
  const built: number[] = [];
  const j = new OiSnapshotJob({
    targets: async () => [{ underlying: 'NIFTY', expiry: E }],
    contracts: async () => [ce, pe],
    freshChain: async () => {
      const at = Date.now();
      built.push(at);
      return chain(at);
    },
    repo,
    clock: new SessionClock({ holidays: MARKET_HOLIDAYS }),
    ...over,
  });
  return { j, repo, built };
}

describe('OiSnapshotJob', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('writes one OI row per quoted contract (null oiChange kept) every 3 minutes while open', async () => {
    const { j, repo } = job();
    jest.setSystemTime(IST('2026-10-12T10:00:00'));
    await j.tick(Date.now());
    expect(repo.oiRows).toEqual([
      { instrumentId: 'i-ce', oi: 1000, oiChange: 50, volume: 3, at: new Date(IST('2026-10-12T10:00:00')) },
      { instrumentId: 'i-pe', oi: 2000, oiChange: null, volume: 3, at: new Date(IST('2026-10-12T10:00:00')) },
    ]);
    jest.setSystemTime(IST('2026-10-12T10:01:00'));
    await j.tick(Date.now());
    expect(repo.oiRows).toHaveLength(2);
    jest.setSystemTime(IST('2026-10-12T10:03:00'));
    await j.tick(Date.now());
    expect(repo.oiRows).toHaveLength(4);
  });

  it('stores the chain JSON on the first run and every 5th run after', async () => {
    const { j, repo } = job();
    for (let i = 0; i < 6; i++) {
      jest.setSystemTime(IST('2026-10-12T10:00:00') + i * 180_000);
      await j.tick(Date.now());
    }
    expect(repo.chainSnapshots).toHaveLength(2); // runs 1 and 6
  });

  it('writes one closing snapshot when the venue closes, then nothing', async () => {
    const { j, repo } = job();
    jest.setSystemTime(IST('2026-10-12T15:28:00'));
    await j.tick(Date.now());
    jest.setSystemTime(IST('2026-10-12T15:30:30'));
    await j.tick(Date.now());
    jest.setSystemTime(IST('2026-10-12T15:40:00'));
    await j.tick(Date.now());
    expect(repo.oiRows).toHaveLength(4);
    expect(repo.chainSnapshots).toHaveLength(2); // first run + closing run
  });

  it('skips a holiday and a closed venue entirely', async () => {
    const { j, repo, built } = job();
    jest.setSystemTime(IST('2026-10-02T11:00:00')); // Gandhi Jayanti (NSE holiday in MARKET_HOLIDAYS)
    await j.tick(Date.now());
    jest.setSystemTime(IST('2026-10-12T20:00:00'));
    await j.tick(Date.now());
    expect(built).toHaveLength(0);
    expect(repo.oiRows).toHaveLength(0);
  });

  it('a chain that cannot be built writes nothing and is counted; a write failure is counted, not thrown', async () => {
    const none = job({ freshChain: async () => null });
    jest.setSystemTime(IST('2026-10-12T10:00:00'));
    await none.j.tick(Date.now());
    expect(none.repo.oiRows).toHaveLength(0);
    expect(none.j.status(Date.now()).failures).toBe(1);

    const broken = job();
    broken.repo.writeOi = async () => {
      throw new Error('db down');
    };
    await expect(broken.j.tick(Date.now())).resolves.toBeUndefined();
    expect(broken.j.status(Date.now()).failures).toBe(1);
  });
});
```

(`2026-10-02` is in `MARKET_HOLIDAYS` for NSE, BSE, MCX and NFO, `market-holidays.service.ts:62`.)

Append to `market-hub.service.spec.ts`:

```ts
  it('prunes OI snapshots older than 30 days through the job runner, as a no-op without a hub', async () => {
    const svc = new MarketHubService(enabled() as any, manager() as any, tracker as any, prisma as any, runner as any, instruments as any);
    svc.onModuleInit();
    const prune = jest.fn().mockResolvedValue(12);
    (svc as any).engine.chains.pruneOi = prune;
    await svc.pruneOiSnapshots();
    expect(runner.run).toHaveBeenCalledWith('hub-oi-prune', expect.anything(), expect.any(Function));
    expect(prune).toHaveBeenCalledWith(expect.any(Date));
    const cutoff = prune.mock.calls[0][0] as Date;
    expect(Date.now() - cutoff.getTime()).toBeGreaterThanOrEqual(30 * 24 * 3600_000 - 1000);
    svc.onModuleDestroy();
  });
```

(If the spec's `runner` mock does not invoke its callback, follow how the existing nightly-fix-up test
drives `runner.run`, e.g. `runner.run.mockImplementation((_n, _o, fn) => fn())`.)

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @td/api test -- oi-snapshot-job.spec market-hub.service.spec`
Expected: FAIL: `Cannot find module './oi-snapshot-job'`; `svc.pruneOiSnapshots is not a function`.

- [ ] **Step 3: Implement `chain/oi-snapshot-job.ts`**

```ts
import { istDay } from '../candles/trading-calendar';
import type { SessionClock } from '../session-clock';
import type { ChainRepo } from './chain-repository';
import type { ChainContract, HubChain, OiRow } from './chain.types';

export const OI_SNAPSHOT_EVERY_MS = 180_000;
export const CHAIN_JSON_EVERY_RUNS = 5;
/** Ticks run every 30 s; allow a run a little early so a 3-minute cadence does not drift to 3.5. */
const EARLY_MS = 15_000;

export interface SnapshotTarget {
  underlying: string;
  expiry: string;
}

export interface OiSnapshotJobDeps {
  targets(now: number): Promise<SnapshotTarget[]>;
  contracts(underlying: string, expiry: string): Promise<ChainContract[]>;
  freshChain(underlying: string, expiry: string): Promise<HubChain | null>;
  repo: Pick<ChainRepo, 'writeOi' | 'writeChainSnapshot'>;
  clock: Pick<SessionClock, 'isOpen'>;
  log?: (m: string) => void;
}

interface TargetState {
  lastAt: number;
  runs: number;
  wasOpen: boolean;
}

/**
 * Spec §3 OiSnapshotJob: every 3 minutes while a target's venue is open, one oi_snapshots row per
 * quoted contract; the full chain JSON on the first run, every 5th run, and once at the venue's close
 * (what the closed-market view and the overnight review read). Never throws.
 */
export class OiSnapshotJob {
  private readonly state = new Map<string, TargetState>();
  private counts = { day: '', rows: 0, failures: 0 };
  private readonly lastAt: Record<string, number> = {};

  constructor(private readonly d: OiSnapshotJobDeps) {}

  async tick(now: number): Promise<void> {
    this.rollDay(now);
    let targets: SnapshotTarget[];
    try {
      targets = await this.d.targets(now);
    } catch {
      this.counts.failures++;
      return;
    }
    for (const t of targets) await this.one(t, now);
  }

  status(now: number): { rowsToday: number; failures: number; lastAt: Record<string, number> } {
    this.rollDay(now);
    return { rowsToday: this.counts.rows, failures: this.counts.failures, lastAt: { ...this.lastAt } };
  }

  private async one(t: SnapshotTarget, now: number): Promise<void> {
    const key = `${t.underlying.toUpperCase()}:${t.expiry}`;
    try {
      const contracts = await this.d.contracts(t.underlying, t.expiry);
      if (contracts.length === 0) return;
      const open = this.d.clock.isOpen(contracts[0].ref.exchange, new Date(now));
      const st = this.state.get(key) ?? { lastAt: Number.NEGATIVE_INFINITY, runs: 0, wasOpen: false };
      this.state.set(key, st);
      const due = open && now - st.lastAt >= OI_SNAPSHOT_EVERY_MS - EARLY_MS;
      const closing = !open && st.wasOpen;
      st.wasOpen = open;
      if (!due && !closing) return;
      st.lastAt = now;

      const chain = await this.d.freshChain(t.underlying, t.expiry);
      if (!chain) {
        this.counts.failures++;
        return;
      }
      const idByToken = new Map(contracts.map((c) => [c.ref.token, c.instrumentId]));
      const at = new Date(chain.at);
      const rows: OiRow[] = [];
      for (const e of chain.entries) {
        for (const leg of [e.ceData, e.peData]) {
          const id = leg?.token ? idByToken.get(leg.token) : undefined;
          if (!leg || !id) continue;
          rows.push({ instrumentId: id, oi: leg.oi, oiChange: leg.oiChange, volume: leg.volume, at });
        }
      }
      this.counts.rows += await this.d.repo.writeOi(rows);
      st.runs++;
      if (closing || st.runs % CHAIN_JSON_EVERY_RUNS === 1) await this.d.repo.writeChainSnapshot(chain);
      this.lastAt[key] = chain.at;
    } catch (err) {
      this.counts.failures++;
      this.d.log?.(`OI snapshot ${key} failed: ${(err as Error)?.message ?? err}`);
    }
  }

  private rollDay(now: number): void {
    const day = istDay(now);
    if (this.counts.day !== day) this.counts = { day, rows: 0, failures: 0 };
  }
}
```

- [ ] **Step 4: Let `ChainService` own the job**

In `chain-service.ts`: import `{ OiSnapshotJob, type SnapshotTarget }` from `./oi-snapshot-job`. Add to
`ChainServiceDeps`:

```ts
  /** OI snapshots for these always-on underlyings (+ held + viewed today). Absent ⇒ the job is off. */
  snapshots?: { core: readonly string[] };
```

Add fields and wire them:

```ts
  private readonly job: OiSnapshotJob | null;
  private jobTimer: ReturnType<typeof setInterval> | null = null;
```

In the constructor body:

```ts
    this.job = d.snapshots
      ? new OiSnapshotJob({
          targets: (now) => this.snapshotTargets(now),
          contracts: (u, e) => this.d.builder.contracts(u, e),
          freshChain: (u, e) => this.freshChain(u, e),
          repo: d.repo,
          clock: d.clock,
          log: d.log,
        })
      : null;
```

(change the constructor from `constructor(private readonly d: ChainServiceDeps) {}` to a body that assigns
`this.job`). In `start()` add:

```ts
    if (this.job && !this.jobTimer) {
      this.jobTimer = setInterval(() => void this.job?.tick(this.now()), 30_000);
      this.jobTimer.unref?.();
    }
```

In `stop()` clear `jobTimer`. Add:

```ts
  /** Core list (nearest expiry) ∪ held chains ∪ chains a screen opened today. */
  async snapshotTargets(now: number): Promise<SnapshotTarget[]> {
    const keys = new Set<string>([...this.held, ...this.viewedKeys(now)]);
    for (const name of this.d.snapshots?.core ?? []) {
      const nearest = (await this.expiries(name))[0];
      if (nearest) keys.add(keyOf(name, nearest));
    }
    return [...keys].map((k) => {
      const [underlying, expiry] = splitKey(k);
      return { underlying, expiry };
    });
  }
```

and in `status()` replace the `snapshot:` line with:

```ts
      snapshot: this.job
        ? { enabled: true, ...this.job.status(this.now()) }
        : { enabled: false, rowsToday: 0, failures: 0, lastAt: {} },
```

Append to `chain-service.spec.ts`:

```ts
  it('snapshot targets are the core list (nearest expiry), held chains and screen-viewed chains', async () => {
    const { svc, repo, now } = service('2026-10-12T10:00:00', { snapshots: { core: ['NIFTY'] } });
    await svc.chain('CRUDEOIL', E, { screen: true });
    repo.heldInfo.set('NFO:H', { name: 'NIFTY', expiry: E });
    await svc.setHeld([{ exchange: 'NFO', token: 'H', symbol: 'x' }]);
    const t = await svc.snapshotTargets(now());
    expect(t.map((x) => `${x.underlying}:${x.expiry}`).sort()).toEqual([`CRUDEOIL:${E}`, `NIFTY:${E}`]);
    expect(svc.status().snapshot.enabled).toBe(true);
  });
```

`hub-engine.ts`: in the `ChainService` construction add
`snapshots: chainDeps.snapshots ? { core: chainDeps.coreUnderlyings } : undefined,`.

- [ ] **Step 5: The prune cron**

`market-hub.service.ts`:

```ts
/** Job name in job_runs and /healthz/detail (health-detail.service.ts EXPECTED_JOBS). */
export const OI_PRUNE_JOB = 'hub-oi-prune';
const OI_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const OI_PRUNE_LEASE_MS = 10 * 60 * 1000;
```

```ts
  /** 02:45 IST daily: drop oi_snapshots older than 30 days (spec §4). A no-op success without chains. */
  @Cron('0 45 2 * * *', { name: OI_PRUNE_JOB, timeZone: 'Asia/Kolkata' })
  async pruneOiSnapshots(): Promise<void> {
    try {
      await this.jobs.run(OI_PRUNE_JOB, { ttlMs: OI_PRUNE_LEASE_MS, onRedisError: 'run-anyway' }, async () => {
        const chains = this.engine?.chains;
        if (!chains) return;
        const removed = await chains.pruneOi(new Date(Date.now() - OI_RETENTION_MS));
        this.logger.log(`OI snapshot prune: ${removed} row(s) older than 30 days removed`);
      });
    } catch (err) {
      this.logger.error(`OI snapshot prune failed: ${(err as Error)?.message ?? err}`);
    }
  }
```

`health-detail.service.ts` `EXPECTED_JOBS`: add

```ts
  // SP1 M5 30-day OI snapshot prune (MarketHubService). Recorded daily, as a no-op success without chains.
  'hub-oi-prune',
```

- [ ] **Step 6: Run the tests and the cron ratchet**

Run: `pnpm --filter @td/api test -- oi-snapshot-job.spec chain-service.spec market-hub health-detail cron-timezone`
Expected: PASS. (`common/schedule/cron-timezone.spec.ts` fails any time-of-day `@Cron` without
`timeZone`; the new one has it. If a `health-detail` spec pins `EXPECTED_JOBS`, update it.)

- [ ] **Step 7: Commit**

Pathspecs: `oi-snapshot-job.ts`, `oi-snapshot-job.spec.ts`, `chain-service.ts`, `chain-service.spec.ts`,
`hub-engine.ts`, `market-hub.service.ts`, `market-hub.service.spec.ts`, `health-detail.service.ts` (+ its
spec if touched). Message: `feat(market-hub): 3-minute OI snapshots, closing chain snapshot, 30-day prune`.

---

### Task 10: `OptionsChainService` asks the hub first; the legacy path is labelled

**Files:**
- Create: `apps/api/src/modules/options-chain/services/chain-view.ts`
- Test: `apps/api/src/modules/options-chain/services/chain-view.spec.ts`
- Modify: `apps/api/src/modules/options-chain/services/options-chain.service.ts` (constructor ~line 101; `getExpiries` line 170; `getOptionsChainWithSpot` lines 238–306; `getMcxOptionsChainWithSpot` lines 318–373; `loadTodaysSnapshot` lines 608–640; `getLiveOptionLtp` line 513)
- Test: `apps/api/src/modules/options-chain/services/options-chain.hub.spec.ts`
- Modify: `apps/api/src/modules/options-chain/controllers/options-chain.controller.ts` (`getChain`, lines 32–92)
- Test: `apps/api/src/modules/options-chain/controllers/options-chain.controller.hub.spec.ts`

**Interfaces:**
- Consumes: `lookupHubPrices`, `HubPriceSource` (`hub-prices.ts`); `HubChains`, `ChainResult` (Task 8);
  `OptionsChainView` (Task 2).
- Produces:

```ts
// chain-view.ts
export interface LegacyChain { chain: OptionsChainEntry[]; spotPrice: number; source: 'nse' | 'snapshot' | 'legacy'; at: number }
export function viewFromHub(res: ChainResult, now: number): OptionsChainView;
export function legacyView(l: LegacyChain, now: number, marketHours: boolean): OptionsChainView;
// OptionsChainService
OptionsChainFetchOptions.screen?: boolean;
getChainView(underlying: string, expiry: string, opts?: OptionsChainFetchOptions): Promise<OptionsChainView>;
// unchanged signatures, now hub-first: getExpiries, getOptionsChain, getOptionsChainWithSpot, getLiveOptionLtp
```

- [ ] **Step 1: Write the failing tests**

`chain-view.spec.ts`:

```ts
import { legacyView, viewFromHub } from './chain-view';

const chain = { underlying: 'NIFTY', expiry: '2026-10-13', exchange: 'NFO' as const, spot: null, at: Date.parse('2026-10-12T04:40:00Z'), greeks: 'local' as const, entries: [] };

describe('chain views', () => {
  it('maps every hub result kind, keeping the chain time and a null spot', () => {
    const now = Date.parse('2026-10-12T04:40:05Z');
    expect(viewFromHub({ kind: 'fresh', chain }, now)).toEqual({ chain: [], spotPrice: null, at: '2026-10-12T04:40:00.000Z', source: 'hub', status: 'fresh', greeks: 'local' });
    expect(viewFromHub({ kind: 'stale', chain, ageMs: 5000 }, now).status).toBe('stale');
    expect(viewFromHub({ kind: 'market-closed', chain }, now).status).toBe('market-closed');
    expect(viewFromHub({ kind: 'unavailable', reason: 'throttled' }, now)).toEqual({ chain: [], spotPrice: null, at: '2026-10-12T04:40:05.000Z', source: 'hub', status: 'unavailable', unavailable: 'throttled' });
  });

  it('labels a legacy chain by its own age: ≤ 60 s fresh, older stale in market hours, market-closed outside', () => {
    const now = Date.parse('2026-10-12T05:00:00Z');
    const l = { chain: [], spotPrice: 25000, source: 'snapshot' as const, at: now - 30_000 };
    expect(legacyView(l, now, true).status).toBe('fresh');
    expect(legacyView({ ...l, at: now - 7 * 86_400_000 }, now, true).status).toBe('stale');
    expect(legacyView({ ...l, at: now - 7 * 86_400_000 }, now, false)).toEqual(expect.objectContaining({ status: 'market-closed', source: 'snapshot', spotPrice: 25000 }));
    expect(legacyView({ ...l, spotPrice: 0 }, now, true).spotPrice).toBeNull();
  });
});
```

`options-chain.hub.spec.ts`:

```ts
import { Logger } from '@nestjs/common';
import { OptionsChainService } from './options-chain.service';
import { GreeksCalculatorService } from './greeks-calculator.service';
import { NseOptionsChainService } from './nse-options-chain.service';

const entries = [{ strikePrice: 25000, expiryDate: '2026-10-13', ceData: null, peData: null }];
const hubChain = { underlying: 'NIFTY', expiry: '2026-10-13', exchange: 'NFO', spot: 25010, at: Date.now(), greeks: 'broker', entries };

function make(chains: Record<string, jest.Mock> | null) {
  const source = { hubFor: jest.fn(() => (chains ? { chains } : null)), record: jest.fn() };
  const moduleRef = { get: jest.fn(() => source) };
  const prisma = { optionChainSnapshot: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) } } as any;
  const nse = new NseOptionsChainService({ get: () => undefined } as any);
  const svc = new OptionsChainService(prisma, new GreeksCalculatorService(), nse, null, {} as any, null, moduleRef as any);
  return { svc, source, nse };
}

describe('OptionsChainService on the market hub', () => {
  beforeEach(() => {
    for (const level of ['warn', 'log', 'debug'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('serves the hub chain with its labels when hubFor(null, "chain") answers, and counts it', async () => {
    const chains = { chain: jest.fn().mockResolvedValue({ kind: 'fresh', chain: hubChain }), expiries: jest.fn(), optionLtp: jest.fn() };
    const { svc, source } = make(chains);
    const view = await svc.getChainView('NIFTY', '2026-10-13', { screen: true });
    expect(source.hubFor).toHaveBeenCalledWith(null, 'chain');
    expect(chains.chain).toHaveBeenCalledWith('NIFTY', '2026-10-13', { screen: true });
    expect(view).toEqual(expect.objectContaining({ chain: entries, spotPrice: 25010, source: 'hub', status: 'fresh' }));
    expect(source.record).toHaveBeenCalledWith('chain', 'hub');
    await expect(svc.getOptionsChainWithSpot('NIFTY', '2026-10-13')).resolves.toEqual({ chain: entries, spotPrice: 25010 });
  });

  it('an unavailable hub chain is an empty chain for internal consumers, never a synthetic one', async () => {
    const chains = { chain: jest.fn().mockResolvedValue({ kind: 'unavailable', reason: 'throttled' }), expiries: jest.fn(), optionLtp: jest.fn() };
    const { svc, source, nse } = make(chains);
    const nseSpy = jest.spyOn(nse, 'getChain');
    await expect(svc.getOptionsChain('NIFTY', '2026-10-13')).resolves.toEqual([]);
    expect(nseSpy).not.toHaveBeenCalled();
    expect(source.record).toHaveBeenCalledWith('chain', 'unpriced');
  });

  it('expiries and single-contract LTP come from the hub', async () => {
    const chains = { chain: jest.fn(), expiries: jest.fn().mockResolvedValue(['2026-10-13']), optionLtp: jest.fn().mockResolvedValue(131.25) };
    const { svc } = make(chains);
    await expect(svc.getExpiries('NIFTY')).resolves.toEqual(['2026-10-13']);
    await expect(svc.getLiveOptionLtp('NIFTY', '2026-10-13T00:00:00.000Z', 25000, 'CE')).resolves.toBe(131.25);
    expect(chains.optionLtp).toHaveBeenCalledWith('NIFTY', '2026-10-13', 25000, 'CE');
  });

  it('with the switch off (hubFor null) the legacy path answers, labelled with its source', async () => {
    const { svc, nse } = make(null);
    jest.spyOn(nse, 'getChain').mockResolvedValue({ chain: entries, spotPrice: 24990 } as any);
    const view = await svc.getChainView('NIFTY', '2026-10-13');
    expect(view).toEqual(expect.objectContaining({ chain: expect.any(Array), spotPrice: 24990, source: 'nse' }));
  });
});
```

`options-chain.controller.hub.spec.ts`:

```ts
import { ServiceUnavailableException } from '@nestjs/common';
import { OptionsChainController } from './options-chain.controller';

describe('GET /api/options/chain on the hub', () => {
  const view = (over: object) => ({ chain: [], spotPrice: null, at: '2026-10-12T04:40:00.000Z', source: 'hub', status: 'fresh', ...over });

  it('an unavailable hub chain is a 503 with the reason', async () => {
    const svc = { getExpiries: jest.fn(), getChainView: jest.fn().mockResolvedValue(view({ status: 'unavailable', unavailable: 'throttled' })) };
    const c = new OptionsChainController(svc as any, {} as any, {} as any, null);
    await expect(c.getChain('NIFTY', { expiry: '2026-10-13' } as any)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('asks as a screen and returns at, source, status and greeks with the chain', async () => {
    const entries = [{ strikePrice: 25000, expiryDate: '2026-10-13', ceData: null, peData: null }];
    const svc = { getExpiries: jest.fn(), getChainView: jest.fn().mockResolvedValue(view({ chain: entries, spotPrice: 25010, greeks: 'broker' })) };
    const c = new OptionsChainController(svc as any, {} as any, {} as any, null);
    const res = await c.getChain('nifty', { expiry: '2026-10-13' } as any);
    expect(svc.getChainView).toHaveBeenCalledWith('nifty', '2026-10-13', { background: true, screen: true });
    expect(res).toEqual({ chain: entries, expiry: '2026-10-13', spotPrice: 25010, underlying: 'NIFTY', at: '2026-10-12T04:40:00.000Z', source: 'hub', status: 'fresh', greeks: 'broker' });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @td/api test -- chain-view.spec options-chain.hub.spec options-chain.controller.hub.spec`
Expected: FAIL: `Cannot find module './chain-view'`; `svc.getChainView is not a function`.

- [ ] **Step 3: Implement `chain-view.ts`**

```ts
import type { OptionsChainEntry, OptionsChainView } from '@td/shared/types';
import type { ChainResult } from '../../market-hub/chain/chain.types';

/** The legacy path's answer, labelled with where it came from and when its prices were current. */
export interface LegacyChain {
  chain: OptionsChainEntry[];
  spotPrice: number;
  source: 'nse' | 'snapshot' | 'legacy';
  at: number;
}

const LEGACY_FRESH_MS = 60_000;

export function viewFromHub(res: ChainResult, now: number): OptionsChainView {
  if (res.kind === 'unavailable') {
    return { chain: [], spotPrice: null, at: new Date(now).toISOString(), source: 'hub', status: 'unavailable', unavailable: res.reason };
  }
  const c = res.chain;
  return { chain: c.entries, spotPrice: c.spot, at: new Date(c.at).toISOString(), source: 'hub', status: res.kind, greeks: c.greeks };
}

/** Legacy chains are labelled by their own age (the 60 s rule loadTodaysSnapshot already uses). */
export function legacyView(l: LegacyChain, now: number, marketHours: boolean): OptionsChainView {
  const status = now - l.at <= LEGACY_FRESH_MS ? 'fresh' : marketHours ? 'stale' : 'market-closed';
  return {
    chain: l.chain,
    spotPrice: l.spotPrice > 0 ? l.spotPrice : null,
    at: new Date(l.at).toISOString(),
    source: l.source,
    status,
  };
}
```

- [ ] **Step 4: Wire the seam into `OptionsChainService`**

Imports: `ModuleRef` from `@nestjs/core`; `{ lookupHubPrices, type HubPriceSource, type HubOutcome }` from
`'../../market-hub/hub-prices'`; `type { HubChains }` from `'../../market-hub/chain/chain.types'`;
`{ legacyView, viewFromHub, type LegacyChain }` from `./chain-view`; add `OptionsChainView` to the
`@td/shared/types` import.

`OptionsChainFetchOptions` gains:

```ts
  /** A screen (GET /api/options/chain): the hub keeps this chain refreshed while it is open. */
  screen?: boolean;
```

Constructor: append `@Optional() private readonly moduleRef?: ModuleRef,` as the LAST parameter (existing
positional constructions in specs keep working). Add:

```ts
  private hubSourceRef: HubPriceSource | null = null;

  /** M5 seam: the hub's chains when HUB_SERVES_CHAIN is on and the hub runs; null → legacy path. */
  private hubChains(): HubChains | null {
    if (!this.hubSourceRef) this.hubSourceRef = lookupHubPrices(this.moduleRef);
    try {
      return this.hubSourceRef?.hubFor(null, 'chain')?.chains ?? null;
    } catch {
      return null;
    }
  }

  private recordHub(outcome: HubOutcome): void {
    try {
      this.hubSourceRef?.record('chain', outcome);
    } catch {
      // counters must never break a chain read
    }
  }

  /** The chain with its labels (`at`, `source`, `status`): hub first, else today's path. */
  async getChainView(underlying: string, expiry: string, opts: OptionsChainFetchOptions = {}): Promise<OptionsChainView> {
    const hub = this.hubChains();
    if (hub) {
      const view = viewFromHub(await hub.chain(underlying, expiry, { screen: opts.screen }), Date.now());
      this.recordHub(view.status === 'unavailable' ? 'unpriced' : 'hub');
      return view;
    }
    const legacy = await this.legacyChainWithSpot(underlying, expiry, opts);
    this.recordHub('legacy');
    return legacyView(legacy, Date.now(), this.isMarketHoursIST());
  }
```

Replace `getOptionsChainWithSpot` with a thin wrapper, and rename the old body:

```ts
  async getOptionsChainWithSpot(
    underlying: string,
    expiry: string,
    opts: OptionsChainFetchOptions = {},
  ): Promise<{ chain: OptionsChainEntry[]; spotPrice: number }> {
    const view = await this.getChainView(underlying, expiry, opts);
    return { chain: view.chain, spotPrice: view.spotPrice ?? 0 };
  }

  /** Today's path (HUB_SERVES_CHAIN off): snapshot → NSE → DB → 7-day snapshot → master. Deleted in Task 13. */
  private async legacyChainWithSpot(underlying: string, expiry: string, opts: OptionsChainFetchOptions): Promise<LegacyChain> {
    // …the previous getOptionsChainWithSpot body, with each return labelled:
  }
```

Label each return of the old body (keep everything else byte-for-byte):
- MCX branch: `return this.getMcxOptionsChainWithSpot(underlying, expiry);` (that method now returns `LegacyChain`, below).
- today's snapshot: `return { chain: …, spotPrice: todaysSnapshot.spotPrice, source: 'snapshot', at: todaysSnapshot.capturedAt.getTime() };`
- NSE: `return { chain: enriched, spotPrice: nseResult.spotPrice, source: 'nse', at: Date.now() };`
- DB chain: `return { chain: dbChain, spotPrice: dbSpot, source: 'legacy', at: Date.now() };`
- 7-day snapshot: `return { chain: …, spotPrice: snapshot.spotPrice, source: 'snapshot', at: snapshot.capturedAt.getTime() };`
- last resort: `return { chain: fallbackChain, spotPrice: 0, source: 'legacy', at: Date.now() };`

`getMcxOptionsChainWithSpot`: return type `Promise<LegacyChain>`; today's snapshot → `source: 'snapshot', at: todaysSnapshot.capturedAt.getTime()`;
live build → `source: 'legacy', at: Date.now()`; 7-day snapshot → `source: 'snapshot', at: snapshot.capturedAt.getTime()`;
scaffold → `source: 'legacy', at: Date.now()`.

`loadTodaysSnapshot`: add `capturedAt: Date` to its return type and `capturedAt: row.capturedAt` to the returned object.

`getExpiries`: first lines become

```ts
    const hub = this.hubChains();
    if (hub) return hub.expiries(underlying);
```

`getLiveOptionLtp`: first lines become

```ts
    const hub = this.hubChains();
    if (hub) return hub.optionLtp(underlying.toUpperCase(), expiryIso.slice(0, 10), strike, optionType);
```

(`getLiveOptionLtpDebug` stays legacy: it is the debug route.)

- [ ] **Step 5: The controller**

`options-chain.controller.ts`: import `ServiceUnavailableException`. Replace the body of `getChain` after the
expiry resolution:

```ts
    const view = await this.optionsChainService.getChainView(underlying, expiry, { background: true, screen: true });
    if (view.status === 'unavailable') {
      throw new ServiceUnavailableException({
        message: `Option chain unavailable for ${underlying.toUpperCase()} ${expiry}`,
        reason: view.unavailable,
      });
    }
    const { chain } = view;

    // Legacy only: the hub already quoted the underlying with the legs when it had no book price.
    let spotPrice = view.spotPrice ?? 0;
    if (spotPrice === 0 && view.source !== 'hub') {
      const indexInfo = INDEX_TOKENS[underlying.toUpperCase()];
      if (indexInfo && this.brokerAdapter) {
        try {
          const quote = await Promise.race([
            this.brokerAdapter.getLiveQuote(indexInfo.token, indexInfo.exchange),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('broker quote timeout')), 1500)),
          ]);
          spotPrice = quote.ltp;
        } catch {
          // fall through to chain-based estimate
        }
      }
    }

    // Fallback: estimate spot from chain (where CE ltp ~ PE ltp)
    if (spotPrice === 0 && chain.length > 0) {
      let closestDiff = Infinity;
      for (const entry of chain) {
        if (entry.ceData && entry.peData && entry.ceData.ltp > 0 && entry.peData.ltp > 0) {
          const diff = Math.abs(entry.ceData.ltp - entry.peData.ltp);
          if (diff < closestDiff) {
            closestDiff = diff;
            spotPrice = entry.strikePrice;
          }
        }
      }
    }

    return {
      chain,
      expiry,
      spotPrice,
      underlying: underlying.toUpperCase(),
      at: view.at,
      source: view.source,
      status: view.status,
      ...(view.greeks ? { greeks: view.greeks } : {}),
    };
```

- [ ] **Step 6: Run the options-chain suites and every chain consumer's specs**

Run: `pnpm --filter @td/api test -- options-chain oi-wall strike-selector market-context overnight-evidence universe-scanner silo-entry-guards open-paper-trade signal-generator`
Expected: PASS, including the three NSE specs (`nse-options-chain.service.spec`, `options-chain.nse-v3.spec`,
`options-chain.nse-timeout.spec`): with no `ModuleRef` the service takes the legacy path exactly as before.
`silo-entry-guards.spec.ts` (trade-core) must pass untouched.

- [ ] **Step 7: Commit**

Pathspecs: `chain-view.ts`, `chain-view.spec.ts`, `options-chain.service.ts`, `options-chain.hub.spec.ts`,
`options-chain.controller.ts`, `options-chain.controller.hub.spec.ts`. Message:
`feat(options-chain): hub-first chains behind HUB_SERVES_CHAIN; every chain labelled with at/source/status`.

---

### Task 11: Web: age badge and a status-driven poll

**Files:**
- Create: `apps/web/src/utils/chainAge.ts`
- Test: `apps/web/src/utils/chainAge.spec.ts`
- Modify: `apps/web/src/stores/options-store.ts`
- Modify: `apps/web/src/hooks/useOptionsChain.ts`
- Modify: `apps/web/src/pages/options/OptionsPage.tsx` (header, next to the spot display ~line 154)
- Modify: `apps/web/src/components/stock-overview/OptionsChainPreviewCard.tsx` (`ChainResponse`, line 29; `Card action`, ~line 157)

**Interfaces:**
- Produces:

```ts
export interface ChainMeta { at?: string | null; source?: string | null; status?: string | null }
export interface ChainBadge { label: string; tone: 'live' | 'stale' | 'closed' | 'legacy' }
export function formatAge(ms: number): string;
export function chainBadge(meta: ChainMeta | null | undefined, now: number): ChainBadge | null;
export const CHAIN_POLL_MS = 10_000;
export const CHAIN_CLOSED_POLL_MS = 60_000;
export function chainPollMs(status: string | null | undefined): number;
export const CHAIN_TONE_CLASS: Record<ChainBadge['tone'], string>;
// options-store: chainMeta: ChainMeta | null (oiSummary + fetchAnalysis removed)
```

- [ ] **Step 1: Write the failing test**

`apps/web/src/utils/chainAge.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { chainBadge, chainPollMs, formatAge } from './chainAge';

const NOW = Date.parse('2026-10-12T05:00:00Z'); // 10:30 IST

describe('chainAge', () => {
  it('formats ages in s, min and h', () => {
    expect(formatAge(4_200)).toBe('4 s');
    expect(formatAge(185_000)).toBe('3 min');
    expect(formatAge(2 * 3600_000 + 5)).toBe('2 h');
  });

  it('labels hub chains Live / Stale and a closed market by its IST snapshot time', () => {
    expect(chainBadge({ at: new Date(NOW - 4_000).toISOString(), source: 'hub', status: 'fresh' }, NOW)).toEqual({ label: 'Live · 4 s', tone: 'live' });
    expect(chainBadge({ at: new Date(NOW - 40_000).toISOString(), source: 'hub', status: 'stale' }, NOW)).toEqual({ label: 'Stale · 40 s', tone: 'stale' });
    expect(chainBadge({ at: '2026-10-12T09:59:00.000Z', source: 'hub', status: 'market-closed' }, NOW)).toEqual({ label: 'Closed · 15:29 snapshot', tone: 'closed' });
  });

  it('labels the NSE fallback as such, and shows nothing without a time', () => {
    expect(chainBadge({ at: new Date(NOW - 9_000).toISOString(), source: 'nse', status: 'fresh' }, NOW)).toEqual({ label: 'NSE · 9 s', tone: 'legacy' });
    expect(chainBadge({ source: 'hub', status: 'fresh' }, NOW)).toBeNull();
    expect(chainBadge(null, NOW)).toBeNull();
  });

  it('polls every 10 s while live or stale and every 60 s on a closed market', () => {
    expect(chainPollMs('fresh')).toBe(10_000);
    expect(chainPollMs('stale')).toBe(10_000);
    expect(chainPollMs(undefined)).toBe(10_000);
    expect(chainPollMs('market-closed')).toBe(60_000);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @td/web test -- chainAge`
Expected: FAIL: `Failed to resolve import "./chainAge"`.

- [ ] **Step 3: Implement `utils/chainAge.ts`**

```ts
/** What a chain response says about itself (GET /api/options/chain → OptionsChainView). */
export interface ChainMeta {
  at?: string | null;
  source?: string | null;
  status?: string | null;
}

export interface ChainBadge {
  label: string;
  tone: 'live' | 'stale' | 'closed' | 'legacy';
}

export const CHAIN_POLL_MS = 10_000;
export const CHAIN_CLOSED_POLL_MS = 60_000;

export const CHAIN_TONE_CLASS: Record<ChainBadge['tone'], string> = {
  live: 'text-[var(--color-accent-green)]',
  stale: 'text-[var(--color-accent-yellow)]',
  closed: 'text-[var(--color-text-muted)]',
  legacy: 'text-[var(--color-accent-blue)]',
};

const IST_HM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });

export function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h`;
}

/** Spec §4: every chain shows its age — "Live · 4 s", "Stale · 40 s", "Closed · 15:29 snapshot", "NSE · 9 s". */
export function chainBadge(meta: ChainMeta | null | undefined, now: number): ChainBadge | null {
  if (!meta?.at) return null;
  const at = Date.parse(meta.at);
  if (!Number.isFinite(at)) return null;
  const age = formatAge(Math.max(0, now - at));
  if (meta.source === 'nse') return { label: `NSE · ${age}`, tone: 'legacy' };
  if (meta.status === 'market-closed') return { label: `Closed · ${IST_HM.format(at)} snapshot`, tone: 'closed' };
  if (meta.status === 'stale') return { label: `Stale · ${age}`, tone: 'stale' };
  if (meta.source === 'hub') return { label: `Live · ${age}`, tone: 'live' };
  return { label: `Updated ${age} ago`, tone: 'legacy' };
}

/** The server's status decides the cadence: no client-side market-hours guess (no holidays, no MCX). */
export function chainPollMs(status: string | null | undefined): number {
  return status === 'market-closed' ? CHAIN_CLOSED_POLL_MS : CHAIN_POLL_MS;
}
```

- [ ] **Step 4: Store, hook, page and preview card**

`stores/options-store.ts`:
- Delete the `OISummary` interface, `oiSummary` (state + initial value), `fetchAnalysis` (type + implementation).
  First confirm nothing else reads them: `grep -rn "oiSummary\|fetchAnalysis" apps/web/src` must list only
  `options-store.ts` and `useOptionsChain.ts`.
- `import type { ChainMeta } from '@/utils/chainAge';`; add `chainMeta: ChainMeta | null;` to `OptionsState`, initial
  `chainMeta: null`, and reset it in `setUnderlying` (`set({ underlying, chain: [], expiry: '', expiries: [], chainMeta: null })`).
- In `fetchChain`'s success path: `const chainMeta: ChainMeta = { at: res.data.at ?? null, source: res.data.source ?? null, status: res.data.status ?? null };`,
  replace `let spotPrice = res.data.spotPrice ?? 0;` (null-safe already) and end with `set({ chain, spotPrice, chainMeta, isLoading: false });`.
- In its `catch`: keep the last chain on screen and say why:

```ts
    } catch (err) {
      const reason = (err as { response?: { status?: number; data?: { reason?: string } } })?.response;
      const error = reason?.status === 503
        ? `Option chain unavailable${reason.data?.reason ? ` (${reason.data.reason})` : ''}`
        : 'Failed to load options chain';
      set({ error, isLoading: false });
    }
```

`hooks/useOptionsChain.ts` (whole file):

```ts
import { useEffect } from 'react';
import { useOptionsStore } from '@/stores/options-store';
import { chainPollMs } from '@/utils/chainAge';

/**
 * Fetches expiries when the underlying changes, then the chain, and keeps polling it: every 10 s while
 * the server says fresh/stale, every 60 s while it says market-closed (so an open page picks up the
 * session start). The server's status replaces the old client-side 09:15–15:30 guess.
 */
export function useOptionsChain() {
  const underlying = useOptionsStore((s) => s.underlying);
  const expiry = useOptionsStore((s) => s.expiry);
  const fetchExpiries = useOptionsStore((s) => s.fetchExpiries);
  const fetchChain = useOptionsStore((s) => s.fetchChain);

  useEffect(() => {
    fetchExpiries();
  }, [underlying, fetchExpiries]);

  useEffect(() => {
    if (!expiry) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      await fetchChain();
      if (cancelled) return;
      timer = setTimeout(loop, chainPollMs(useOptionsStore.getState().chainMeta?.status));
    };
    void loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [underlying, expiry, fetchChain]);
}
```

`pages/options/OptionsPage.tsx`: `import { chainBadge, CHAIN_TONE_CLASS } from '@/utils/chainAge';`, read
`const chainMeta = useOptionsStore((s) => s.chainMeta);`, compute `const badge = chainBadge(chainMeta, Date.now());`
(the page re-renders on every poll, so the age is current to within one poll), and right after the
`{/* Spot price display */}` block add:

```tsx
        {badge && (
          <span className={cn('text-xs font-mono', CHAIN_TONE_CLASS[badge.tone])} title="Option chain age">
            {badge.label}
          </span>
        )}
```

`components/stock-overview/OptionsChainPreviewCard.tsx`: extend `ChainResponse` with
`at?: string; source?: string; status?: string;` and `spotPrice: number | null;`; import
`{ chainBadge, CHAIN_TONE_CLASS }` from `@/utils/chainAge`; compute `const badge = chainBadge(data, Date.now());`
just before the `return (` of the main render; change the `Card`'s `action` to:

```tsx
      action={
        <span className="flex items-center gap-3">
          {badge && <span className={`text-xs font-mono ${CHAIN_TONE_CLASS[badge.tone]}`}>{badge.label}</span>}
          <Link to={`/options/${symbol}`} className="text-xs text-blue-400 hover:text-blue-300">
            View full chain →
          </Link>
        </span>
      }
```

- [ ] **Step 5: Run the web tests and typecheck**

Run: `pnpm --filter @td/web test -- chainAge`
Expected: PASS.
Run: `pnpm --filter @td/web exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

Pathspecs: `chainAge.ts`, `chainAge.spec.ts`, `options-store.ts`, `useOptionsChain.ts`, `OptionsPage.tsx`,
`OptionsChainPreviewCard.tsx`. Message: `feat(web): option chain age badge; poll cadence from the server's status`.

---

### Task 12: Verification and production gate

**Files:**
- Modify: `docs/superpowers/plans/2026-10-11-sp1-m5-option-chain-hub.md` (the ledger at the end)

- [ ] **Step 1: Whole API suite**

Run: `pnpm --filter @td/api test 2>&1 | tail -15`
Expected: every suite passes. M5 adds 10 API spec files (`user-option-greeks.util`, `chain-dates`,
`chain-repository`, `chain-math`, `chain-builder`, `chain-service`, `oi-snapshot-job`, `chain-view`,
`options-chain.hub`, `options-chain.controller.hub`); every other new test extends an existing file.
Record totals.

- [ ] **Step 2: Whole web suite**

Run: `pnpm --filter @td/web test 2>&1 | tail -15`
Expected: every file passes (+1 file, `chainAge.spec`). Record totals.

- [ ] **Step 3: The ratchets are unchanged**

Run: `pnpm --filter @td/api test -- only-door.spec cron-timezone`
Run: `git diff main -- apps/api/src/modules/market-hub/only-door.spec.ts apps/api/src/modules/trade-core/`
Expected: PASS and an empty diff (`KNOWN_VIOLATORS` did not grow; trade-core untouched).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @td/api exec tsc --noEmit -p tsconfig.json 2>&1 | grep -E "market-hub|options-chain|oi-wall|market-data/services/user-|health-detail|configuration" || echo "no errors in M5 API files"`
Expected: `no errors in M5 API files`, or only errors on lines unchanged since the merge base (check with
`git blame`), e.g. the environmental TS2307 on `@td/shared/types` the M2–M4 ledgers recorded.
Run: `pnpm --filter @td/web exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Migration dry run**

Run: `pnpm --filter @td/api exec prisma migrate diff --from-migrations ../../prisma/migrations --to-schema-datamodel ../../prisma/schema.prisma --shadow-database-url "$SHADOW_DATABASE_URL" --script`
Expected: an empty script (the migration matches the schema). If no shadow database is available
locally, record "not run" and rely on the deploy's `prisma migrate deploy` + the gate's SQL check.

- [ ] **Step 6: Record and commit**

Fill in the ledger table below, then commit the plan file alone. Message: `docs(plans): SP1 M5 verification results`.

---

## M5 production gate (after deploy, owner-run)

**Deploy 1 — snapshots only.** Merge and push (the VPS deploy runs `prisma migrate deploy`, which applies
`20261011120000_sp1_m5_option_chain_hub`). Keep `HUB_SERVES_CHAIN=false`; leave `HUB_OI_SNAPSHOT_ENABLED`
unset (default on). Restart the API.

During that session (NSE 09:15–15:30 and MCX until 23:30):

```sql
-- OI rows are being written for the core list (expect ≈ 41×2 rows per underlying every 3 minutes)
SELECT i.name, count(*), max(s."timestamp")
FROM oi_snapshots s JOIN instruments i ON i.id = s."instrumentId"
WHERE s."timestamp" >= now() - interval '30 minutes'
GROUP BY i.name ORDER BY i.name;
-- want: NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY (+ CRUDEOIL, NATURALGAS) with recent max(timestamp)

-- a closing chain snapshot per core underlying
SELECT underlying, max("capturedAt") FROM option_chain_snapshots WHERE source = 'HUB' GROUP BY underlying;
```

`/healthz/detail → hub.value.chain.snapshot`: `enabled: true`, `rowsToday` rising, `failures` 0 (or a
handful around a deploy restart). `governor.endpoints.greek.throttlesLastHour` ≈ 0.

**Deploy 2 — switch on (next session).** Set `HUB_SERVES_CHAIN=true`, restart the API, hard-reload the
browser. Over one NSE session plus one MCX evening:

- **Options page** (NIFTY, then BANKNIFTY, then CRUDEOIL after 15:30): the badge reads **Live · ≤ 10 s** at
  every look while that venue is open; NIFTY reads **Closed · 15:3x snapshot** after the close while
  CRUDEOIL stays Live. OI Chg columns show numbers for the core list (this is day 2 of snapshots).
- **Stock preview card** (an F&O stock, e.g. RELIANCE): the chain shows, with a badge. Its OI Chg shows "-"
  on the first day it is opened (no baseline yet), numbers from the next session.
- **`/healthz/detail → hub.value`:** `consumers.flags.chain = true`; `consumers.chain.hub` rising and
  `consumers.chain.unpriced` ≈ 0; `chain.buildP95Ms` < 1000; `chain.unavailable.throttled` = 0;
  `chain.greeksLocal` ≈ 0 (non-zero means optionGreek is failing: check logs for "Greeks computed locally");
  `governor.endpoints.quote.throttlesLastHour` ≈ 0; `prices.oldestP0AgeMs` < 5000 (positions unaffected).
- **Downstream:** the sentinel's OI walls are still written:
  `SELECT symbol, max("capturedAt") FROM oi_wall_snapshots WHERE "capturedAt" >= now() - interval '1 hour' GROUP BY symbol;`
  and a chart's S/R evidence still lists `OI_CALL` / `OI_PUT` (and `OI_CHANGE` from day 2).
  A trade opened that day records `pcrAtEntry` and `maxPainAtEntry` (non-null).
- **Logs:** no "option chain … build failed" lines except around a restart; no
  `OI walls unavailable for NIFTY: chain empty`.

**Revert path:** `HUB_SERVES_CHAIN=false` puts every chain consumer back on today's path (NSE scrape +
legacy) without a deploy. Not behind the switch: the OI snapshot job (`HUB_OI_SNAPSHOT_ENABLED=false`
stops it), the migration, the age labels on legacy chains, and the web badge/poll changes.

M5's hub chain is complete when this gate is observed in production, not when tests pass. Then run Task 13.

---

### Task 13 (after the gate passes): Delete the NSE scrape and the legacy chain paths

**Do not start this task until the owner confirms the M5 production gate passed.** It removes the revert path.

**Files:**
- Delete: `apps/api/src/modules/options-chain/services/nse-options-chain.service.ts`,
  `nse-options-chain.service.spec.ts`, `options-chain.nse-v3.spec.ts`, `options-chain.nse-timeout.spec.ts`,
  `services/__fixtures__/nse-contract-info-nifty.json`, `nse-contract-info-reliance.json`, `nse-v3-nifty.json`,
  `nse-v3-reliance.json`; `scripts/seed-nse-chains.mjs`;
  `apps/api/src/modules/market-data/workers/oi-tracker.processor.ts` (never queued) and its registration
  (`market-data.module.ts:53-55` queue, `:96` provider) plus any spec of it.
- Modify: `apps/api/src/modules/options-chain/services/options-chain.service.ts`, `options-chain.module.ts`,
  `controllers/options-chain.controller.ts`, `deploy/env/api.env.example` (lines 52–57, the
  `NSE_OPTION_CHAIN_*` keys), `apps/api/src/config/configuration.ts` (remove `hub.servesChain`),
  `apps/api/src/modules/market-hub/{hub-prices.ts,hub-engine.ts,market-hub.service.ts}` (the `'chain'`
  consumer switch), `apps/api/src/modules/market-hub/only-door.spec.ts`.

**Interfaces:**
- Produces: `OptionsChainService` keeps `getExpiries`, `getOptionsChain`, `getOptionsChainWithSpot`,
  `getChainView`, `getLiveOptionLtp`, `getPCR`, `getMaxPain`, `getOISummary`, `cleanupOldSnapshots`, all
  hub-only. With no hub (hub disabled), `getChainView` returns `status: 'unavailable', unavailable: 'no-session'`.

- [ ] **Step 1: Write the failing test**

In `options-chain.hub.spec.ts` replace the "switch off" test with:

```ts
  it('without a hub the chain is unavailable: no-session (there is no other source)', async () => {
    const { svc } = make(null);
    await expect(svc.getChainView('NIFTY', '2026-10-13')).resolves.toEqual(expect.objectContaining({ status: 'unavailable', unavailable: 'no-session', source: 'hub' }));
    await expect(svc.getExpiries('NIFTY')).resolves.toEqual([]);
    await expect(svc.getLiveOptionLtp('NIFTY', '2026-10-13', 25000, 'CE')).resolves.toBeNull();
  });
```

In `only-door.spec.ts` remove `'modules/options-chain/services/options-chain.service.ts'` and its `// M5` comment from `KNOWN_VIOLATORS`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @td/api test -- options-chain.hub.spec only-door.spec`
Expected: FAIL: the legacy path still answers; `options-chain.service.ts` still calls `.optionGreek(`.

- [ ] **Step 3: Delete**

In `options-chain.service.ts` delete: `legacyChainWithSpot`, `getMcxOptionsChainWithSpot`,
`buildMcxChainFromMaster`, `getChainFromDB`, `buildOptionDataFromDB`, `getChainFromMaster`,
`mapOptionGreekData`, `buildSyntheticChain`, `computeGreeksAndIV`, `enrichGreeks`, `getSpotForUnderlying`,
`getOptionContracts` + `contractsCache`, `getExpiriesFromSnapshots`, `getExpiriesFromDB`,
`loadTodaysSnapshot`, `loadLatestSnapshot`, `persistSnapshot`, `withTimeout`, `chainHasRealData`,
`spotFromChain`, `getLiveOptionLtpDebug`, the `MCX_COMMODITIES` / `INDEX_SPOT_TOKENS` /
`NSE_HOT_PATH_TIMEOUT_MS` / `CACHE_TTL_MS` constants and the `OptionContract` / `CachedContracts` types; and
the constructor dependencies `NseOptionsChainService`, `BROKER_ADAPTER_TOKEN` adapter, `AngelOneAuthService`,
`MarketFeedService` (keep `PrismaService` for `cleanupOldSnapshots`, `GreeksCalculatorService` if still
used, and `ModuleRef`). The hub-only methods become:

```ts
  async getChainView(underlying: string, expiry: string, opts: OptionsChainFetchOptions = {}): Promise<OptionsChainView> {
    const hub = this.hubChains();
    const view = hub
      ? viewFromHub(await hub.chain(underlying, expiry, { screen: opts.screen }), Date.now())
      : viewFromHub({ kind: 'unavailable', reason: 'no-session' }, Date.now());
    this.recordHub(view.status === 'unavailable' ? 'unpriced' : 'hub');
    return view;
  }

  async getExpiries(underlying: string): Promise<string[]> {
    return (await this.hubChains()?.expiries(underlying)) ?? [];
  }

  async getLiveOptionLtp(underlying: string, expiryIso: string, strike: number, optionType: 'CE' | 'PE'): Promise<number | null> {
    return (await this.hubChains()?.optionLtp(underlying.toUpperCase(), expiryIso.slice(0, 10), strike, optionType)) ?? null;
  }
```

`hubChains()` now asks `hubFor(null, 'chain')` with no switch: remove `'chain'` from `HubConsumer`,
`CONSUMER_FLAG`, `ConsumerFlags`, `consumerCounts`, `status().consumers` and `configuration.ts`, and give the
seam an always-on accessor instead: add to `HubPriceSource`

```ts
  /** M5: the owner hub's option chains whenever the hub runs (chains have no revert switch after M5). */
  chainsFor(userId: string | null): HubChains | null;
```

implemented in `MarketHubService` as
`return this.engine && (userId === null || userId === this.ownerUserId) ? this.engine.chains : null;`,
and call `this.hubSourceRef?.chainsFor(null) ?? null` from `OptionsChainService.hubChains()`. Record outcomes
with a new `chain` block inside `ChainStatus` instead of `consumers.chain` (or drop `recordHub`; the
`chain.unavailable` counters already cover it). Update the Task 1 test in `market-hub.service.spec.ts` to
`chainsFor` accordingly.

`options-chain.module.ts`: remove `NseOptionsChainService` from providers. Controller: delete
`debug-live-ltp` and `mcx-test` routes, `INDEX_TOKENS` and the `BROKER_ADAPTER_TOKEN` injection, and the
legacy spot branch. Delete the files listed above, the `NSE_OPTION_CHAIN_*` lines from
`deploy/env/api.env.example`, and the `oi-tracker` processor + its queue registration.

Search for leftovers: `grep -rn "NseOptionsChainService\|seed-nse-chains\|NSE_OPTION_CHAIN\|oi-tracker\|capture-oi\|getLiveOptionLtpDebug\|HUB_SERVES_CHAIN\|servesChain" apps deploy scripts docs/superpowers/plans/2026-10-11-sp1-m5-option-chain-hub.md`
Expected: only this plan's own text (and historical docs/specs).

- [ ] **Step 4: Run everything**

Run: `pnpm --filter @td/api test 2>&1 | tail -15`
Expected: every suite passes (three NSE specs gone). `only-door.spec` passes with the shorter list.
Run: `pnpm --filter @td/api exec tsc --noEmit -p tsconfig.json 2>&1 | grep -E "options-chain|market-hub|market-data.module" || echo "clean"`
Expected: `clean`.

- [ ] **Step 5: Commit**

Pathspecs: every deleted and modified file above (`git rm` the deletions first). Message:
`refactor(options-chain): delete the NSE scrape and legacy chain paths; the hub is the only chain source`.

After deploying: remove `HUB_SERVES_CHAIN` and `NSE_OPTION_CHAIN_*` from `/opt/grw/env/api.env`.

---

## Notes for later milestones (not in this plan)

- **Multi-tenant:** chain consumers are system jobs; with one hub per user, they need a "system hub"
  choice (spec §3). Today `hubFor(null, 'chain')` (and `chainsFor(null)` after Task 13) is the owner's hub.
- **M6:** max-pain de-duplication (service, `OiWallService`, overnight adapter, web `OIAnalysis`); one index
  token map; `OPTION_LOT_SIZES` → `OptionData.lotSize`; `watch-monitor/strike-selector` can now read
  `token`/`lotSize` off the chain (its TODO); market-context spot off `MarketFeedService`.
- **BFO / SENSEX options:** not in the derivative master (`DERIVATIVE_SEGMENTS` is NFO + MCX).
- **Expired contracts** are never deactivated by the master refresh; the chain filters by date. A cleanup
  belongs with the master refresh.
- **WebSocket push of chains:** not needed while the Options page polls the hub's cache (no broker call).

## Verification ledger

| Date | Check | Result |
|---|---|---|
| 2026-10-12 | API suite (suites / tests) | PASS: 296/296 suites, 3750/3750 tests (892 s). Jest printed "A worker process has failed to exit gracefully" once. Re-running in band with `jest market-hub --detectOpenHandles` (26 suites / 250 tests) and `jest options-chain market-data/services market-data/controllers --detectOpenHandles` (34 / 350) reported no open handle, so no M5 suite can be named as the leak |
| 2026-10-12 | Web suite (files / tests) | PASS: 72/72 files, 646/646 tests (includes `chainAge.spec`) |
| 2026-10-12 | only-door + cron-timezone; trade-core diff empty | PASS: 2 suites / 5 tests; `git diff 17058f1..HEAD -- only-door.spec.ts trade-core/` is empty |
| 2026-10-12 | API typecheck (M5 files) | 19 errors, matching the pre-existing baseline (worktree config `tsconfig.api-wt.json`). The only one in a file this branch touched is `market-data.controller.ts(980)` TS2339 `updateInstrumentTokenFrom`. `git blame` shows the line is from ^68c8957 (2026-06-29), so this branch did not change it. No chain-repository/Prisma-client error |
| 2026-10-12 | Web typecheck | PASS: `tsc --noEmit` exit 0, no errors |
| 2026-10-12 | Migration diff | Not run: no SHADOW_DATABASE_URL locally. Relies on the deploy's `prisma migrate deploy` and the gate's SQL check |
