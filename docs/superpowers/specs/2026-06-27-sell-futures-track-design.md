# SELL-Futures Track — Short Stock Futures on Bearish Chartink Signals

**Date:** 2026-06-27
**Area:** New track module `apps/api/src/modules/sell-futures-track` + Chartink trigger
**Status:** Approved design — ready for implementation plan

---

## Motivation

The `2026-06-01-ungated-sell-direction-finding.md` research showed the pipeline already computes a `SELL` direction (from sector/stock 15m trend) and that those shorts were profitable — but SELL was then **blocked** by the BUY-only gate on the equity tracks. This feature routes those bearish signals to a **new paper track that shorts the stock's future** (where the stock has one), isolating short exposure in the correct instrument (a future you can legally short and hold intraday) instead of an equity short.

Empirically verified (`tmp-futures-probe.mjs`): the Angel One master carries **647 FUTSTK contracts across 229 underlyings**; a stock→future lookup resolves token/expiry/lotSize (e.g. RELIANCE → token 62802, 30JUN2026, lot 500).

---

## Scope (confirmed)

| Dimension | Decision |
|-----------|----------|
| Direction | **SELL-only** (short futures). BUY signals ignored by this track. |
| Mode | **Paper first** (live behind a flag is a later, separate change). |
| Holding | **Intraday** — EOD square-off, no overnight carry. |
| Signal source | **Same Chartink alerts** that feed the ungated track. |
| Sizing | **1 lot per trade** (`quantity = lotSize`). |

---

## Architecture

New isolated track module, cloned from `ungated-track` (the established multi-track pattern used by adaptive-stop and breakout-swing). Hooks into `chartink-process.processOne()` as a fire-and-forget shadow — **no change to existing tracks' behavior**.

```
Chartink alert → processOne() [computes side]
   if side === 'SELL':  void runSellFuturesShadow({ alertId, symbol, eqToken, exchange, scanName, hitPrice, side })
        → SellFuturesService.createFromAlert(input)
             gate 1: resolve future (FutureSelectorService) — else reject 'no-future'
             gate 2: symbol dedup (by futures token)
             gate 3: cooldown (45m)
             gate 4: position cap / margin pool / kill switch
             gate 5: live quote on FUTURES token (NFO)
             size: quantity = lotSize  (1 lot)
             targets: target = entry × 0.98 (−2%), hardSL = entry × 1.004 (+0.4%)
             auto-execute paper SELL at live futures price
   SellFuturesTickPoller (REST 30s) → target / SL / trailing / EOD square-off 15:15 IST
```

---

## Components

### 1. `FutureSelectorService` (new) — the linchpin
`resolve(symbol: string): Promise<ResolvedFuture | null>`
- Normalize the incoming symbol: strip `-EQ`, uppercase, trim.
- Filter the cached instrument master for `instrumenttype === 'FUTSTK'` matched on the underlying (`name`, with normalization to bridge the equity-symbol ↔ futures-`name` gap — see Risk below).
- Pick the **current-month** expiry; roll to next month when within `ROLL_DAYS` (default 3) of expiry.
- Return `{ token, tradingsymbol, exchange: 'NFO', expiry: Date, lotSize: number }`, or `null` when the stock has no future.
- Reuses the adapter's cached master (`ensureMasterCache` / `fetchInstrumentMaster('NFO')`). Pattern mirrors `getOptionContracts`.
- **Unit-tested** heavily (normalization is where silent misses hide).

### 2. `SellFuturesService` (new) — entry gates + execution
- `createFromAlert(input)` with the gate sequence above. Error classes per gate (mirror `Ungated*Error`): `SellFuturesNoFutureError`, `SellFuturesSymbolDupError`, `SellFuturesCooldownError`, `SellFuturesPositionCapError`, `SellFuturesNoQuoteError`, `SellFuturesKillSwitchError`.
- `onTick(entry, price)` exit logic: target-hit, hard SL (two-strike guard optional, reuse ungated approach), trailing, and EOD square-off.

### 3. `SellFuturesTickPoller` (new)
REST poll every 30s over open futures tokens (NFO), fresh-price-gated (reuse `ExitPriceService` pattern), plus a 15:15 IST EOD square-off sweep. Clone of `ungated-tick-poller`.

### 4. `SellFuturesPaperAccount` (new)
- Paper margin pool `PAPER_MARGIN_POOL = ₹40,00,000`.
- Per-trade estimated margin = `notional × MARGIN_PCT` (`MARGIN_PCT = 0.20`); deploy on open, release on close.
- Short P&L = `(entry − exit) × lotSize − fees`.
- Position cap `MAX_OPEN_POSITIONS = 25`.

### 5. Repositories + Prisma models (new, cloned from ungated)
- `SellFuturesWatchEntry`, `SellFuturesTrade`, `SellFuturesRejection`. Entry stores both the equity symbol and the resolved futures `token`/`tradingsymbol`/`expiry`/`lotSize`. Apply via `prisma db push` (NEVER `migrate dev`; NEVER `prisma generate --no-engine`).
- `SellFuturesRejectionReason`: `'no-future' | 'symbol-dup' | 'cooldown' | 'position-cap' | 'margin-exhausted' | 'kill-switch' | 'no-quote'`.

### 6. `SellFuturesController` (new) — API only
`GET /api/sell-futures/watch`, `/watch/:id`, `/paper-account`. No UI page this iteration.

### 7. Wiring
- `SellFuturesModule` registered in `app.module.ts`.
- `chartink-process.service.ts`: inject the service, add `runSellFuturesShadow` fire-and-forget call guarded by `side === 'SELL'`, with error→rejection mapping (`mapSellFuturesError`). **Gated/ungated/adaptive/breakout paths unchanged.**

### Constants (`sell-futures-track/constants.ts`)
```
PROFIT_TARGET_PCT = 0.02      // short: target = entry × (1 − this)
HARD_STOP_PCT     = 0.004     // short: SL = entry × (1 + this)  [first tuning lever → ~0.01]
EOD_SQUAREOFF_IST = '15:15'
LOTS_PER_TRADE    = 1
MARGIN_PCT        = 0.20
PAPER_MARGIN_POOL = 4_000_000
MAX_OPEN_POSITIONS= 25
TRADE_COOLDOWN_MS = 45 * 60_000
ROLL_DAYS         = 3
```

---

## Risk / known gotcha

**Symbol ↔ futures-`name` matching.** The probe returned `TATAMOTORS=false` even though it trades futures — the master's `name` field uses its own convention (renames/demergers, `-EQ` stripping). The `FutureSelectorService` normalization must bridge this, and it MUST be unit-tested against known F&O names, or stocks that *do* have futures get silently skipped (a quiet-miss the codebase is sensitive to). When a known F&O stock fails to resolve, log a warning rather than dropping it silently.

---

## Testing

- **`FutureSelectorService`:** resolves RELIANCE → nearest expiry/lot; strips `-EQ`; returns null for a non-F&O smallcap; picks current-month and rolls within `ROLL_DAYS`; handles a name-normalization case.
- **`SellFuturesService`:** no-future → `SellFuturesNoFutureError` + recorded, no entry; happy path opens a paper short at futures price with `quantity = lotSize`; dedup / cooldown / position-cap / no-quote gates; target & SL exits compute correctly for a SHORT; EOD square-off closes open positions.
- **`chartink-process`:** `side==='SELL'` routes to the track; `side==='BUY'` does not; error→reason mapping.
- **Regression:** existing track suites unaffected.

---

## Out of scope (this iteration)

- Live futures execution (paper only).
- Overnight / carryforward positions.
- BUY (long-future) direction.
- `/sell-futures` UI page (API only).
- Full SPAN/exposure margin model (flat `MARGIN_PCT` estimate is sufficient for paper).
- Exit-threshold optimization (start at parity, tune later).

---

## Implementation plan (phased)

1. **Schema** — add 3 models + reason enum; `prisma db push`.
2. **FutureSelectorService** (+ adapter `getFutureContracts` helper if cleaner) + unit tests. *Independent — can start in parallel with phase 3.*
3. **Paper account + repositories** (clone ungated) + tests.
4. **SellFuturesService** (gates, execution, onTick) + tests.
5. **SellFuturesTickPoller** (poll + EOD square-off).
6. **Controller + module wiring** + `app.module` registration.
7. **chartink-process trigger** (`runSellFuturesShadow`, `mapSellFuturesError`) + tests.
8. **Verify** — run sell-futures + chartink suites green; confirm no regression in other tracks.

---

## Files (new unless noted)

```
prisma/schema.prisma                                              (edit: 3 models + enum-ish reason)
apps/api/src/modules/sell-futures-track/
  constants.ts
  sell-futures.module.ts
  services/future-selector.service.ts            (+ .spec.ts)
  services/sell-futures.service.ts               (+ .spec.ts)
  services/sell-futures-tick-poller.service.ts
  services/sell-futures-paper-account.service.ts (+ .spec.ts)
  repositories/sell-futures-watch.repository.ts
  repositories/sell-futures-trade.repository.ts
  repositories/sell-futures-rejection.repository.ts
  controllers/sell-futures.controller.ts
apps/api/src/modules/market-data/services/angel-one-adapter.service.ts  (edit: getFutureContracts, optional)
apps/api/src/modules/chartink/services/chartink-process.service.ts      (edit: SELL trigger + error map)
apps/api/src/app.module.ts                                              (edit: register module)
```
