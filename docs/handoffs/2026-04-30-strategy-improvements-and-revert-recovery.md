# Session Handoff — Strategy Improvements + Revert Recovery

**Date:** 2026-04-30
**Branch:** `main` (uncommitted working tree — see "Working tree state" below)
**Last commit:** `57418de` *feat(signals): lock optimal options-strike pick into analyze response*

This was a long session. Substantial work was completed and **also lost** to repeated file reverts by an external process (likely an editor / linter / backup tool). What's left in the working tree is one coherent feature shipped today (adaptive invalidation) plus several earlier-session fixes that need to be **re-applied** before the system is fully healthy.

---

## What was completed this session and is currently in the working tree

### Adaptive setup invalidation (A + B + C) — load-bearing, fully shipped

User-reported problem: a BUY setup fired, the market briefly went their way, then reversed, but the locked setup held the call until the original SL hit. Three early-exit mechanisms now address this.

**Backend** — `apps/api/src/modules/signal-generator/services/setup-tracker.service.ts`:
- New fields on `LockedSetup`: `invalidationKind` (`'structural'|'counter-setup'|'time-mfe'|null`), `invalidationReason`, `mfeR` (running max-favorable excursion in R units), `triggerBarTimestamp`.
- Constants: `MFE_STRUCTURAL_TRIGGER_R = 0.5`, `TIME_MFE_BARS = 8`, `TIME_MFE_PROGRESS_R = 0.5`, `TIMEFRAME_MS = 15min`.
- `updateFromTick` now runs an invalidation pre-check **before** target/SL/partial-take logic for `ACTIVE`/`PARTIAL_BOOKED` setups:
  - **A. Structural**: if MFE ≥ 0.5×R then spot retraces through entry → INVALIDATED (`"Spot retraced through entry after 0.62×R MFE — momentum failed"`).
  - **C. Time-MFE**: if 8+ bars elapsed AND MFE < 0.5×R → INVALIDATED (`"9 bars elapsed with only 0.30×R MFE — no follow-through"`).
- New public method `flagCounterSetup(token, oppositeSide, oppositeLevelType, oppositeReason)` for **B**.
- `close()` accepts optional `invalidationKind`/`invalidationReason`. `invalidate()` accepts an optional `kind` (defaults to `'manual'`).

**Backend** — `apps/api/src/modules/signal-generator/services/signal-generator.service.ts`:
- `AnalyzeResult.kind = 'setup'` extended with `invalidationKind?` / `invalidationReason?`.
- Before `lock()`, calls `flagCounterSetup` if the new fire is opposite-side to an existing active setup.
- `lockedToResult()` populates the invalidation fields from the persisted setup.

**Backend tests** — `setup-tracker.service.spec.ts`: **17/17 pass** (9 existing + 8 new). Covers A.1/A.2/A.3, B/B-no-op, C.1/C.2, PENDING-ignored.

**Frontend** — `apps/web/src/components/charts/AnalysisPanel.tsx`:
- `SetupAnalysis` extended with `invalidationKind?` / `invalidationReason?`.
- Amber banner above Entry/SL/Target when status is `INVALIDATED` and reason exists; Entry/SL/Target dim to `opacity-60`.
- `StatusBadge` mechanism-aware: `STRUCTURAL EXIT` (amber), `COUNTER FLIP` (violet), `TIMED OUT` (gray), falls through to `CLOSED`.

**Frontend** — `apps/web/src/components/trading/SignalCard.tsx`:
- Amber `⚠ Invalidated: <reason>` tag below the setup-context block when present (defensive guards).
- **Also fixed in this file**: the levels-context block is now gated on `signal.setupContext.setupType` (was crashing for `asymmetric-edge` signals which use a different `setupContext` shape — `levelValue.toFixed(2)` was throwing). Each `.toFixed()` and `.replace()` call is now `typeof === 'number'` guarded.

**Frontend types** — `apps/web/src/types/index.ts`:
- `invalidationKind`/`invalidationReason` added to `SetupContext` (nested under setup-context, not at signal root — matches AnalysisPanel contract).

### Recently re-applied fixes (HMR live)

These were lost to reverts and re-applied at the end of the session:

- **`apps/web/src/hooks/useChartData.ts`** (line 269 area): `/watch` POST body `null` → `{}`. Express's strict JSON parser was rejecting `null` and returning 400 for every chart load. Symptom: console errors `POST /api/market-data/instruments/<token>/watch?exchange=NSE 400 (Bad Request)`.
- **`apps/web/src/components/charts/CandlestickChart.tsx`**: ResizeObserver callback now guarded by `disposed` flag + try/catch around `chart.applyOptions`. Cleanup wraps `chart.remove()` and `unsubscribeCrosshairMove` in try/catch. Eliminates the `Object is disposed` error from `lightweight-charts` during fast unmounts.
- **`apps/web/vite.config.ts`**: port reverted to `4000`, proxy targets reverted to `127.0.0.1:4001`. The file had reverted to vite-default `3000` / proxy → `3001`.

### Memory entries created/updated this session

In `~/.claude/projects/C--Users-AryanKumar-Desktop-TD-Automation/memory/`:
- `project_localhost_ipv6_docker.md` — Node→Docker on Windows: `localhost` resolves to `::1` and silently fails to reach containers; use `127.0.0.1` in `.env`.
- `project_cors_port_3000_legacy.md` — Several gateways had `origin: 'http://localhost:3000'` but web runs on 4000; caused 1–3 min socket flap cycles. **Fix is currently REVERTED — see below.**
- `project_angel_one_historical_rate_limit.md` — `getCandleData` silently returns empty when throttled; adapter needs TTL cache + 350ms serial pacer to stay under the limit. **Fix is currently REVERTED — see below.**
- Index updated in `MEMORY.md`.

---

## ⚠ What was completed earlier in the session and got REVERTED

These fixes are **NOT in the working tree** — the files match HEAD instead of the in-session edits. They were verified working before reverting. Re-apply when convenient. Listed in priority order:

| Priority | File | What was lost | Symptom of being missing |
|---|---|---|---|
| **HIGH** | `apps/api/src/modules/market-data/services/candle-aggregator.service.ts` | Volume-delta tracking (`lastCumulativeVolume` map + `deriveVolumeDelta`) | Live-aggregated bars get massively inflated volumes (saw `182M` on a single 15m ONGC bar). Historical DB bars are unaffected. |
| **HIGH** | `apps/api/src/modules/market-data/services/market-feed.service.ts` | Forwarding the delta from `candleAggregator.processTick` to `levelBookService.updateFromTick` | VWAP corrupted by cumulative-volume readings (biased toward end-of-day). |
| **HIGH** | `apps/api/src/modules/market-data/services/angel-one-adapter.service.ts` | TTL cache (timeframe-scaled: 30s/60s/5min/1h) + in-flight dedup + 350ms serial pacing chain (`paceHistoricalFetch`) for `getHistoricalData` | Cold-load of any non-universe symbol fans out to 4 historical fetches in <100ms; Angel One throttles silently and the strategy reports `not enough candles (got 0, need 25 for 15m)`. |
| **HIGH** | `apps/api/src/modules/market-data/controllers/market-data.controller.ts` | Broker-fallback when DB candles don't span requested range (oldest DB candle test against `from + 6h` slack) | Charts show only today's live-built bars when the daily-backfill cron hasn't run or the symbol joined the universe between cron firings. Looks like "discontinuity in the graph". |
| **HIGH** | `apps/api/src/main.ts` | CORS `origin: ['http://localhost:4000', 'http://localhost:3000']` | Browser socket.io flaps every 1–3 minutes (live ticks arrive in bursts then stall). |
| **HIGH** | `apps/api/src/modules/market-data/gateways/market-data.gateway.ts`, `auto-trade/gateways/auto-trade.gateway.ts`, `trade-engine/gateways/trade.gateway.ts` | Same CORS array | Same flap cycle as main.ts; gateway-specific. |
| **MED** | `apps/api/src/modules/signal-generator/services/signal-generator.service.ts` | The structured rejection collector + `RankedReject[]` on the no-setup variant + `buildRankedRejectionsImpl` helper | Ranked-rejects panel in the chart shows nothing. The frontend rendering code (in `AnalysisPanel.tsx`) is still in place but receives empty `rejections`. |
| **MED** | `apps/web/src/pages/charts/ChartsPage.tsx` | (1) URL ↔ store sync (refresh-safe charts via `?symbol=&token=&exchange=&tf=`); (2) Auto-detected pivot-based S/R lines with confluence-star scoring | Charts revert to NIFTY default on refresh; auto S/R lines absent. The util file `apps/web/src/utils/computeSupportResistance.ts` is still on disk (untracked) but unused. |
| **MED** | `apps/web/src/components/charts/CandlestickChart.tsx` | Volume series `lastValueVisible: false`, `priceLineVisible: false`, and volume scale `visible: false` | Floating volume value (e.g. `4.12M`) renders inside the price column instead of staying in the volume strip. |

**Pattern of the reverts:** repeated touches by what looks like an editor save-buffer revert or a backup-replay process. Backend agent #1 in this session also flagged it explicitly: *"the file-revert behavior I encountered (twice) means an external process is rolling back unsaved buffers in this repo."* Whatever this is, it kicked in between the edits and the next session-resume; if it's reproducible, identifying the culprit is worth doing before re-applying the lost work (otherwise the same revert will eat it again).

**Re-application strategy when ready:** the memory entries above describe the *why* of each fix; the diff content for each is recoverable from the conversation history of this session. For the HIGH-priority items, dispatching a single backend agent with a clear brief to "re-apply these specific changes" is the fastest path. The volume-delta + adapter cache + CORS fixes are the most load-bearing — without them, daily trading is materially degraded.

---

## Pending work (awaiting user input)

### F&O stock universe expansion — proposed but not implemented

User asked: *"can we find signals in stocks who have futures and provide exceptional return"*. Current scanner only watches NIFTY, BANKNIFTY, CRUDEOIL, COPPER.

**My recommendation in the conversation** was a curated 20-stock list (HDFCBANK, ICICIBANK, SBIN, KOTAKBANK, AXISBANK, BAJFINANCE, TCS, INFY, RELIANCE, POWERGRID, ONGC, TATASTEEL, JSWSTEEL, HINDALCO, TATAMOTORS, M&M, ITC, ASIANPAINT, BHARTIARTL, LT) — fits within the Angel One 50-token WS budget, all liquid F&O names with ATR ≥ ~1%.

**The change touches:**
1. Add `FNO_STOCKS` constant in `packages/shared/src/constants/index.ts` (tokens + lot sizes).
2. Extend `UNIVERSE` in `apps/api/src/modules/signal-generator/services/level-book.cron.ts`.
3. Extend `WATCHED` in `apps/api/src/modules/signal-generator/workers/universe-scanner.worker.ts` (with lot sizes for the strike selector).
4. Add new tokens to the primary-token boot list in `apps/api/src/modules/market-data/services/market-feed.service.ts` (validate total ≤ 30 primary slots).
5. Move `OPTION_LOT_SIZES` from `signal-generator.service.ts` into the new constant for single source of truth.
6. Backfill historical candles for the new tokens (the daily-backfill worker handles this once they're in the `instrument` table).

**Open questions for the user before implementing:**
- Confirm the 20-stock list (or supply an alternative).
- Static curated list now, dynamic ranking (top N by yesterday's volume × ATR each morning) as a Phase-3 follow-up — confirm this approach.

---

## Service state at handoff

| Port | What | PID | Started | Notes |
|---|---|---|---|---|
| 4000 | Web (Vite) | 25040 | 4/29 11:05 AM | Long-running vite from yesterday; HMR active. |
| 4001 | API (NestJS dev) | 36316 | 4/30 9:20 AM | Current dev API. |
| 5432 | Postgres (`td-postgres` container) | — | — | `.env` uses `127.0.0.1` (correct for the IPv6/Docker quirk on this Windows box). |
| 6379 | Redis (`td-redis` container) | — | — | `.env` uses `127.0.0.1`. |

### Stale processes that should be cleaned up

These are leftovers from earlier sessions; nothing useful is running on them. Mentioned to the user but not killed:

| Port | PID | Started | What it is |
|---|---|---|---|
| 3000 | 33648 | 4/29 1:32 AM | Old vite |
| 3001 | 6444 | 4/29 11:50 PM | Old vite or API |

The `25040` PID also appears on 3001 in some `Get-NetTCPConnection` snapshots — Windows port-binding state appears inconsistent between query times. Resolution: kill the stale ones and re-check.

---

## Key open questions

1. **Why are files reverting?** Identifying this before re-applying the load-bearing fixes is important. Suspects: a paired editor/IDE on a different machine writing back, a Time Machine / backup restore replaying old versions, an OneDrive/Dropbox sync conflict, a git hook running on file watcher. Worth `ls -la --time` on a few of the reverted files to compare modification time vs the revert moment, and worth checking if Windows File History / OneDrive is enabled on this directory.
2. **F&O stock universe — which list and which approach?** (See "Pending work" above.)
3. **Cleanup of stale node processes on 3000/3001?** Confirm before killing.

---

## Quick next-actions checklist

For the next session, in priority order:

- [ ] Identify and stop whatever is reverting files. Without this, any re-application is wasted.
- [ ] Re-apply the HIGH-priority lost fixes from the table above (volume-delta + market-feed forwarding, Angel One adapter cache + rate limiter, CORS in main.ts and 3 gateways, broker-fallback in market-data controller).
- [ ] Kill stale processes on 3000/3001.
- [ ] Confirm F&O stock universe with user, then implement the 6 touch-points listed above.
- [ ] Re-apply the MED-priority lost fixes (rejection collector in signal-generator; URL sync + auto S/R + volume-label hide on the chart). These are quality-of-life — the system functions without them but the analyze panel is less informative and the chart less readable.
- [ ] Commit the adaptive-invalidation work (currently uncommitted in the working tree). Sensible commit boundary: 9 modified files form one coherent feature.
