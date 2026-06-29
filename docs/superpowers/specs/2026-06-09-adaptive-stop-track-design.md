# Adaptive-Stop Track — Design

> Date: 2026-06-09 · Status: Design (approved, pre-spec-review)
> Area: `apps/api` · new parallel paper track · Phase 1 = backend only

## Purpose

A third paper-trading track that runs a **volatility-based, risk-decoupled stop-loss**
on the **same trades the gated track already takes**, so we can A/B whether the
better stop closes greener. Grounded in the 2026-06-09 counterfactual
([[project-stop-too-tight]]): the current stop (~0.4% of deployed capital → a
0.4% price stop) sits *inside* the ~0.6% noise band, and ~80% of stop-outs
recover above entry; real-candle sim put the sweet spot near ~1% (ATR-relative).

## Why mirror the GATED track (not ungated)

The experiment must isolate **one variable — the stop.** That requires the
entry population to be identical to what we actually trade: the **gated,
score-passing** setups. Mirroring ungated (no score gate) would test the stop on
a different, lower-quality population and conflate "better stop" with "different
trades." The counterfactual was measured on the gated `watch_entries`, so we fix
and re-test the stop on that same population.

- **Control:** gated track (`watch-monitor`) — score gate + current ~0.4% stop.
- **Variable:** Adaptive-Stop track — **same score gate, same entries, same
  target**, only the **stop + position sizing** change.
- Ungated track is left untouched as the separate "no-gate" reference.

## Architecture

**Structure** mirrors the `ungated-track` module — it's the purpose-built
self-contained parallel-experiment harness (own paper account, tick-poller,
comparison service, rejection repo). **Entry population** mirrors the gated track
(only admitted, score-passing setups). So: ungated's *harness* + gated's
*entries* + the new *stop/sizing*.

```
apps/api/src/modules/adaptive-stop-track/
├── repositories/adaptive-stop-watch.repository.ts
├── repositories/adaptive-stop-trade.repository.ts
├── services/adaptive-stop-watch.service.ts        # createFromAlert + onTick (NEW stop/sizing)
├── services/adaptive-stop-trade-execution.service.ts
├── services/adaptive-stop-account.service.ts      # paper account (₹80L, 40-slot cap — same as ungated)
├── services/adaptive-stop-tick-poller.service.ts  # 30s REST poll, mirror ungated
├── services/adaptive-stop-comparison.service.ts   # win%, avg/trade, target-hit for the A/B
├── gateways/adaptive-stop.gateway.ts
├── controllers/adaptive-stop.controller.ts        # read endpoints
└── adaptive-stop-track.module.ts
```

**Prisma models** (mirror `WatchEntry`/gated trade + new fields):
- `AdaptiveStopWatchEntry` — all `WatchEntry` fields **plus**: `riskAmount` (₹ risked),
  `atrAtEntry` (5m ATR used), `stopPct` (resolved stop distance %), `stopBasis`
  (`'atr' | 'floor' | 'cap'`), `quantity` (risk-first sized).
- `AdaptiveStopTrade` — mirror the gated/ungated paper-trade model.
- Tables: `adaptive_stop_watch_entries`, `adaptive_stop_trades`. Applied via
  `prisma db push` (repo convention — never `migrate dev`, [[project_prisma_db_push_not_migrate]]).

**Hook point:** in `chartink-process.service.ts` **Stage 4**, inside the
`policy.admitted` branch — right where `watch.createFromAlert` is called — also
call `adaptiveStopWatch.createFromAlert(...)` with the **same inputs**, in its
own independent try/catch (a failure must never affect the gated or ungated
paths). It is NOT called in the rejected branch (keeps the score gate).

## The new stop & sizing (the "settings" — v1 constants)

In `adaptive-stop-track/constants.ts`:

| Constant | Default | Meaning |
|---|---|---|
| `RISK_PER_TRADE` | `800` | ₹ risked per trade (= the ~0.4%-of-₹2L the gated track implies; keeps the A/B risk-fair) |
| `ATR_MULT` | `1.2` | stop = this × intraday ATR |
| `MIN_STOP_PCT` | `0.8` | floor on stop distance (% of entry) — never tighter than the noise |
| `MAX_STOP_PCT` | `2.5` | cap on stop distance (% of entry) — bounds risk on wild names |
| `GRACE_MIN` | `2` | minutes after entry during which the stop is not honored (and only a *close* beyond stop counts, not a wick) |
| `STARTING_BALANCE` / `MAX_CONCURRENT` | `80_00_000` / `40` | same as ungated, for comparability |

**Stop placement (at entry):**
```
atr5m      = ATR(14) over recent 5m candles (fetched like sr-evidence/chartink-scoring)
stopDist   = clamp(ATR_MULT * atr5m, MIN_STOP_PCT% * entry, MAX_STOP_PCT% * entry)
stopPrice  = entry - stopDist            // BUY-only, same as the other tracks
stopBasis  = which bound bound it (atr | floor | cap)   // recorded for analysis
```
(Exact `ATR_MULT` / bounds are tunable and will be calibrated against the
real-candle sim `scripts/cf-real-candles.mjs`.)

**Risk-first sizing:**
```
quantity   = floor(RISK_PER_TRADE / stopDist)        // smaller positions when stop is wider
deployed   = quantity * entry                         // informational
```
If `quantity < 1` (stop so wide one share exceeds the risk budget) → reject the
entry with a logged reason (mirrors the ungated rejection pattern).

**Stop honoring (in `onTick`):**
- Within `GRACE_MIN` of entry: do **not** trigger the stop.
- After grace: trigger only when a candle/tick **closes** ≤ `stopPrice` (not a
  single wick) — kills the noise shake-outs.
- Everything else — target (2%/obstacle), partial-take, trailing-stop —
  **mirrored from the gated track unchanged.**

## Phasing

- **Phase 1 (this spec): backend track + comparison endpoint.** Entries flow,
  the new stop/sizing runs, the tick-poller manages exits, and a
  `/adaptive-stop/comparison` endpoint reports win% / avg-per-trade /
  target-hit next to the gated + ungated numbers. Green-ness is validatable from
  the numbers immediately.
- **Phase 2 (separate spec, later): dedicated UI page** mirroring the gated/
  ungated views.

## Safety / scope

- **Paper-only** — no real broker orders; mirrors the ungated paper account.
- **Independent try/catch** at the hook — cannot affect gated/ungated.
- **No change** to the gated or ungated tracks' behavior.
- A full settings *UI panel* is out of scope for v1 (constants/env only).

## Testing

Unit tests (mirror ungated/gated service specs):
- **Sizing math:** `quantity = floor(RISK_PER_TRADE / stopDist)`; reject when `<1`.
- **Stop resolution:** ATR path, MIN floor path, MAX cap path → correct `stopPrice` + `stopBasis`.
- **Grace logic:** no stop inside `GRACE_MIN`; wick vs close after grace.
- **Admission guards** reused from the gated/ungated pattern (dedup, cooldown,
  last-loss, no-quote, BUY-only, capital, position-cap) — smoke-level.

## Out of scope (v1)
- UI page (Phase 2).
- Settings UI panel (constants only).
- SELL-side entries (BUY-only, same as current tracks).
- Changing the gated/ungated tracks.
