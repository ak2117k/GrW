# SP1 · M5 — Option Chain and OI on the Market Hub — Design

**Date:** 2026-10-11
**Status:** Approved in conversation (sections 1–4); awaiting review of this written spec
**Parent:** `docs/superpowers/specs/2026-10-05-sp1-market-data-hub-design.md` (§3.1 `chain()`, §4 Governor,
§7 Option chain and OI, §9 M5 row, §10, §11)
**Branch:** `feature/sp1-m5-option-chain-hub` (worktree `.claude/worktrees/sp1-m5-option-chain-hub`), from
`main` at `17058f1`
**Constraint:** no edits under `apps/api/src/modules/trade-core/` (SP2 M3 in progress elsewhere).

---

## 1. Problem (as the code stands on 2026-10-11)

A read-only map of the code found:

1. **The hub has no chain path.** `MarketHubService` has no `chain()`; `HubBroker` has no `optionGreek`
   (the Governor already budgets `greek: 0.8/s`, unused); the `QuoteBatcher` is private to the poller.
2. **Every non-NSE chain path runs on the dead shared feed account** (`BROKER_ADAPTER_TOKEN` →
   `AngelOneAdapterService`, `AngelOneAuthService.getSmartApi()`). The MCX chain makes ~42 serial,
   ungoverned `getLiveQuote` calls per build. In production only the NSE website scrape
   (`nse-options-chain.service.ts`, v3 fix b7b3767) yields a real chain.
3. **NSE is the only source of real `oiChange`, IV, bid/ask and stock-option chains.** `oiChange` feeds
   `OiWallService.oiChangeWalls` (sentinel walls, S/R evidence), the strike selector and the overnight review.
4. **The DB-master paths never match real contracts:** they filter `segment: 'OPTIONS'`; the derivative
   master writes `segment: 'NFO' | 'MCX'`. Expired contracts are never deactivated.
5. **`OISnapshot` is never written** (no code queues the `oi-tracker` `capture-oi` job). Chain persistence
   is `OptionChainSnapshot` (full chain JSON, written on every fetch, 30-day cleanup), which also backs an
   **unlabelled 7-day fallback** and is read by the sentinel overnight review.
6. **Silent fallbacks:** synthetic Black-Scholes chains with IV fixed at 15 % and OI 0, `spotPrice: 0`,
   `enrichGreeks` substituting 15 % IV, no `at` on any chain, freshness checked only 09:15–15:30 on
   weekdays (no holidays, no MCX evening).

## 2. Goal and success criteria

The option chain and OI snapshots come from the owner's market hub — one governed broker session.

| Criterion | Target (production) |
|---|---|
| Chain load (cold, market open) | < 1 s p95 |
| Every chain response | carries `at`, `source`, `status` |
| Chain throttles | 0 in a normal session |
| `oiChange` for core underlyings | non-null from the second session after deploy |
| Broker calls for chains outside the hub | 0 after the deletion task (only-door test green) |
| Downstream | sentinel walls, S/R evidence and trade-entry PCR / max pain still populated |

**Owner decisions (2026-10-11):**
- **(a)** NSE scrape and legacy per-strike paths stay behind a revert switch (`HUB_SERVES_CHAIN`) for
  one gated session, then are deleted by M5's last task.
- **(b)** `oiChange` = current OI − the contract's **last OI snapshot of the previous session** (NSE's
  meaning). No baseline → `null` ("unknown"), never 0.
- **(c)** OI snapshots every 3 min for: a configurable core list + underlyings of held options +
  underlyings whose chain was requested today (sticky for the session).
- **(d)** Approach A: the hub builds chains; `OptionsChainService` keeps its public API and delegates.

## 3. Architecture

```
OptionsChainService (public methods unchanged)
  ├─ hubFor(owner, 'chain') == null  → today's path (NSE + legacy), untouched
  └─ hub available                   → hub.chain(underlying, expiry, { strikesAround })

market-hub/chain/
  ChainContracts   DB Instrument: name = underlying, expiry = date, segment ∈ {NFO, MCX},
                   optionType ∈ {CE, PE}, expiry ≥ today (IST). Cached per (underlying, expiry) per day.
                   Also: expiries(underlying) = distinct future expiries, ascending.
  ChainBuilder     1. contracts (ChainContracts)
                   2. spot: hub price of the underlying ref (index / equity; MCX = front-month future,
                      reusing market-hub/underlying.ts)
                   3. pick ±strikesAround strikes around spot (or around the min |CE−PE| strike if no spot)
                   4. quotes: one public batched FULL quote via the Governor (≤ 50 refs/call, Interactive
                      lane when a caller waits, Routine for refresh/snapshot) → ltp, oi, volume, bid/ask (L1 depth)
                   5. greeks: HubBroker.optionGreek(underlying, expiry) on the `greek` endpoint, cached 60 s;
                      on failure: local IV solve + Greeks from each leg's LTP (GreeksCalculatorService), `greeks:'local'`
                   6. oiChange: oi − previous-session last OISnapshot per contract (OiBaseline, cached per day)
                   → HubChain, held in memory; refreshed every ~10 s only while watched
  ChainWatch       a chain request renews a 2-min watch on (underlying, expiry); held options keep their
                   underlying's nearest + held expiries watched. No watch → no refresh.
  OiSnapshotJob    every 3 min while SessionClock says the venue is open:
                   for each target underlying (core ∪ held ∪ requested-today), nearest expiry (+ held expiries)
                   → reuse a chain built < 10 s ago, else build (Routine lane)
                   → OISnapshot rows (one per contract) + one OptionChainSnapshot (underlying, expiry)
                   + one final run at each venue's close
```

**Hub API additions** (`MarketHubService` / `HubPrices` seam):
- `chain(underlying, expiry, { strikesAround = 10, lane? }) → ChainResult`
- `expiries(underlying) → string[]` (YYYY-MM-DD, IST)
- `quoteNow(refs, lane) → Price[]`: the public form of the Governor batch (used by `ChainBuilder`).
- `HubBroker.optionGreek(name, expiryDDMMMYYYY)`; implemented in `ManagerHubBroker` → `UserFeedManager` →
  `UserFeedSession`, and in the FakeBroker.

**Consumer seam:** new `HubConsumer` member `'chain'`, config key `hub.servesChain` from
`HUB_SERVES_CHAIN` (default off), added to `CONSUMER_FLAG`, `ConsumerFlags` and the per-consumer counters.
Unlike M3/M4, `hubFor(null, 'chain')` returns the owner's hub: chain data is market-wide, not user-private,
and the chain consumers (scanners, sentinel walls, trade-entry PCR, `/api/options`) have no user. Only
`'chain'` gets this rule; other consumers keep "never for `null`". *Multi-tenant later:* chain consumers
need a "system hub" choice; recorded here, not built.

**Single-contract LTP:** `OptionsChainService.getLiveOptionLtp` (paper-trade refresher, telegram tracker)
resolves the contract from `ChainContracts` and returns `hub.price(ref, { maxAgeMs: 15 000 })` after a
2-min watch (`owner: 'chain:ltp'`). No per-strike `getLiveQuote`.

**Closed market / holiday:** the chain is served from the latest `OptionChainSnapshot` for that
(underlying, expiry) with `status: 'market-closed'` and its `at`. No broker call, no refresh.

**Config** (`config/configuration.ts`): `HUB_SERVES_CHAIN` (bool, default false),
`HUB_OI_CORE_UNDERLYINGS` (default `NIFTY,BANKNIFTY,FINNIFTY,MIDCPNIFTY,CRUDEOIL,NATURALGAS`),
`HUB_OI_SNAPSHOT_ENABLED` (bool, default **true**, so baselines build before the switch is turned on).

## 4. Data, types and screens

**Database** (one Prisma migration, no new tables):
- `OISnapshot`: reused, keyed on real NFO/MCX `Instrument` rows. Add index `[timestamp]` for pruning.
  Retention 30 days (daily prune cron, `timeZone: 'Asia/Kolkata'`). The `oiChange` column becomes
  `BigInt?` and stores the computed change, `NULL` when there was no baseline.
- `Instrument`: add index `[name, expiry]`.
- `OptionChainSnapshot`: written only by `OiSnapshotJob` (no more write-per-fetch); `source` gains `'HUB'`.
  Existing 30-day cleanup unchanged.
- `OiWallSnapshot`: unchanged (sentinel-owned, write-on-change).

**Shared type** (`packages/shared/src/types`, additive):
- `OptionData` legs gain `token?: string`, `lotSize?: number`; `oiChange` becomes `number | null`.
- Chain response (`GET /api/options/chain/:underlying`) gains `at: string` (ISO), `source: 'hub' |
  'snapshot' | 'nse' | 'legacy'`, `status: 'fresh' | 'market-closed' | 'stale'`, `greeks?: 'broker' |
  'local'`. Existing fields (`chain`, `expiry`, `spotPrice`, `underlying`) keep their meaning;
  `spotPrice` may be `null` when spot is unavailable.

**REST** (`/api/options/*`): routes unchanged. With the switch on, `/expiries` comes from
`hub.expiries()` (DB master, IST dates), `/chain` and `/analysis` from `hub.chain()`.

**Web:**
- Options page and `OptionsChainPreviewCard` show an age badge from `at`/`status`/`source`
  ("Live · 4 s", "Closed · 15:29 snapshot", "Stale · 40 s", "NSE"). Formatter is a pure function.
- `useOptionsChain` keeps its 10 s poll but decides whether to poll from the last response's `status`
  (10 s while `fresh`/`stale`, 60 s while `market-closed` so an open page picks up the session start),
  replacing the client-side 09:15–15:30 check.
- The unused `fetchAnalysis` 10 s call is removed (`OIAnalysis` computes the same numbers client-side).

## 5. Error handling

| Situation | Behaviour |
|---|---|
| Quote batch throttled | Governor back-off; the cached chain returns `status: 'stale'` with `at`; with no cache → `Unavailable('throttled')`, REST 503. Never an empty chain that looks real. |
| `optionGreek` fails / throttled | Local IV + Greeks from LTP; `greeks: 'local'`. No fixed 15 % IV. |
| Hub not running / switch off | Legacy path, labelled `source: 'nse' \| 'legacy'`, `at` = fetch time (or snapshot time). |
| No contracts in DB master | `Unavailable('no-contracts')`; reason in `/healthz/detail`; no synthetic chain. |
| Spot unavailable | Chain served with `spotPrice: null`, centred on the min \|CE−PE\| strike. |
| Market closed / holiday | Latest `OptionChainSnapshot`, `status: 'market-closed'`; no broker call. |
| No OI baseline | `oiChange: null`; `OiWallService` treats null as "no change data" and skips change-based walls (it must not coerce null to 0). |

`/healthz/detail` gains a `chain` block: builds/min, build p95, cache hits, throttled, greeks-local,
unavailable by reason, snapshot rows written today, last snapshot time per core underlying. `Unavailable`
and `greeks: 'local'` log a warning at most once per underlying per session.

## 6. Testing

TDD with the FakeBroker and fake clock.

- **ChainContracts:** selects `segment NFO|MCX` (not `OPTIONS`), skips expired by IST date, expiries ascending.
- **ChainBuilder:** ±N strikes around spot; min |CE−PE| centring without spot; 42 legs → 1 quote call,
  60 → 2; greeks join and local fallback; `oiChange` from previous-session baseline / null; status kinds;
  10 s in-memory reuse; refresh stops when the watch expires.
- **HubBroker.optionGreek:** goes through the `greek` budget; a throttle becomes `Throttled`.
- **OiSnapshotJob:** target set = core ∪ held ∪ requested-today; runs only while SessionClock says open
  (holiday, MCX evening, close-time final run); writes `OISnapshot` + `OptionChainSnapshot`; 30-day prune.
- **OptionsChainService seam:** switch off → today's path unchanged (existing specs stay green); switch on →
  hub; `hubFor(null, 'chain')` → owner hub, `hubFor(null, 'browser')` still null.
- **OiWallService:** null `oiChange` is not treated as 0.
- **Only-door spec:** `options-chain.service.ts` stays in `KNOWN_VIOLATORS` until the deletion task.
- **Web (Vitest):** age-badge formatter; poll rule from `status`.
- **trade-core ceiling:** `silo-entry-guards.spec.ts` constructs `UniverseScannerWorker` positionally — its
  constructor and its use of `OptionsChainService.getExpiries` stay unchanged.

## 7. Rollout, production gate, deletion

1. Merge and deploy with `HUB_SERVES_CHAIN=false`, `HUB_OI_SNAPSHOT_ENABLED=true`: baselines start.
2. Next session: `HUB_SERVES_CHAIN=true`.
3. **Production gate** (owner-run, one NSE session + one MCX evening): Options page shows "Live ≤ 10 s";
   chain build p95 < 1 s in `/healthz/detail`; 0 chain throttles; `oiChange` non-null for the core list
   from day two; sentinel walls and S/R evidence populated; a trade entry records PCR / max pain.
4. **Deletion task** (after the gate): remove `nse-options-chain.service.ts`, its 3 specs and 4 fixtures,
   `NSE_OPTION_CHAIN_*` env keys, `scripts/seed-nse-chains.mjs`; the per-strike `getLiveQuote` paths,
   `getChainFromDB`, `getChainFromMaster`, `buildSyntheticChain`, `buildMcxChainFromMaster`, the 7-day
   fallback, `enrichGreeks`' 15 % substitute; the never-queued `oi-tracker` processor; the switch itself;
   and the `options-chain.service.ts` entry in `KNOWN_VIOLATORS`.

## 8. Out of scope

Max-pain de-duplication (×4) and index-token-map de-duplication; hard-coded `OPTION_LOT_SIZES`;
BFO / SENSEX options (not in the master); WebSocket push of chains; `OiShiftFactor`; market-context spot via
`MarketFeedService` (M6); `OiWallSnapshot` OI values; anything under `trade-core/`.

## 9. Open items for the implementation plan

- Confirm the `optionGreek` response shape and expiry format against the SmartAPI SDK used by
  `UserFeedSession` (the legacy call passes `{ name, expirydate: 'DDMMMYYYY' }`).
- Confirm MCX options' underlying name in the master matches the core list (`CRUDEOIL`, `NATURALGAS`).
- Decide whether `strikesAround` > 24 (more than 50 legs) is ever requested by the web page; if so, two calls.
