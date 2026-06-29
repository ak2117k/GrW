# Session Handoff — Stop-Loss Overhaul, Adaptive-Stop Track, Exit-Coverage

**Date:** 2026-06-10
**Branch:** `main` (pushed to `ak2117k/TD` @ `2cfd8e8`)
**Theme:** "Chartink signals are good, but we bleed on entry/exit." Root-caused the stop, shipped a parallel A/B track, fixed exit-price coverage across all tracks, and added intraday partial booking.

This was a very long session. All work is **committed and pushed** (32 commits, `2793756..2cfd8e8`). App was running throughout (`pnpm dev`, web :4000 / api :4001, Docker postgres+redis).

---

## What shipped (merged to main + pushed)

1. **S/R support fairness** — `computeVolumeNodes` now selects volume nodes **per-side** of LTP (was global top-5, starved support when price sat low in range). Honest scoring kept. ([[project_stop_too_tight]] context.)
2. **OI-wall side semantics** — only **OTM** OI forms a wall (calls above spot / puts below); `oi-wall.service` filters before ranking, so `scoreAndCluster` no longer mis-sides ITM OI.
3. **Adaptive-Stop track (NEW, Phase 1 + 2)** — see [[project-adaptive-stop-track]]. A 3rd paper track: **ungated harness + GATED admitted entries + a new stop** (vol-based 1.2×ATR floor0.8%/cap2.5%, **risk-first sizing**, 2-min grace). Hooked at `chartink-process` Stage-4 admitted branch (own try/catch). UI page `/adaptive-stop` + nav (ShieldHalf, EXP). A/B vs gated at `GET /api/adaptive-stop/comparison?date=YYYY-MM-DD`. Tables `adaptive_stop_*`.
4. **Adaptive-Stop PRICE_CHANGE events** — cloned-from-ungated meant the event log only showed INITIAL; now emits PRICE_CHANGE on ≥0.25% moves (mirrors gated WatchService).
5. **Fresh-or-surface exit pricing** — see [[project-exit-price-fresh-or-surface]]. New `@Global` `ExitPriceService.resolveExitPrices` (REST batch → per-token REST → level-book only if freshly ticked). Pollers (anand intraday/swing/reinvest, ungated, adaptive-stop) now evaluate stops on a FRESH price and **WARN-surface** instead of silently skipping. Never fires on stale.
6. **Gated REST backstop** — `WatchBackstopPollerService` (@Cron 30s): the gated `watch-monitor` track was WS-only; now WS-starved TRADED positions (lastTickAt>60s) get priced via ExitPriceService and exited. All tracks now have held-token exit coverage.
7. **Intraday semi (partial) profit booking** — at **+3%** book **50%** at the fresh price + move runner stop to **breakeven**; runner keeps the existing +5%-arm/Supertrend trail but can't go red. Realized P&L blends both legs (`intraday-pnl.ts`). Intraday ONLY (swing already exits+reinvests at +10%). Fixes the give-back (PANAMAPET +6.7%→0% would now net ~+1.5%).

---

## Key R&D findings (analysis, not all acted on)

- **Stop too tight** ([[project_stop_too_tight]]): current SL = **0.4% of deployed capital = a 0.4% price stop**, inside the ~0.6% noise band. Counterfactual: **~80% of BUY stop-outs recover above entry, ~36% reach target, only ~3–4% genuine saves.** Real-candle sim: optimal stop ≈ **~1%** (not wider). The 0.4% is a *sizing artifact* (deploy fixed capital → risk 0.4% of it → tight stop forced). → motivated the Adaptive-Stop track.
- **Entry-lateness thesis did NOT survive real candles** — on real OHLC we enter near the open; the "58-min lag" was a `hitPrice`-proxy artifact.
- **S/R headroom factor backtest** — inconclusive; historical data can't validate it (indices have no volume; volume stocks have ~1mo history; OI not backtestable). Findings doc: `docs/superpowers/specs/2026-06-09-sr-headroom-backtest-findings.md`.
- **Target/RR audit** (NOT fixed): the default RR gate (floor 2.0) is effectively dead code because `computeSlAndTarget` constructs the target to ≥2×SL; targets aim *through* near walls; TP1-obstacle uses pivot `zones` while the target uses the richer `candidates` set — inconsistent. Worth fixing.
- **Intraday give-back**: Supertrend(10,3) 15m trail sits ~3×ATR (~7%) below the peak → winners round-trip to breakeven before it fires. → motivated partial booking.

---

## Open follow-ups (prioritized)

1. **5 red `WatchService.onTick` hard-loss-cut tests** ([[project_hard_loss_cut_tests_failing]]) — pre-existing/undiagnosed, and it's the **stop-loss safety path** the new backstop now drives. Highest priority.
2. **Held-token live-coverage data gap** — some valid tokens (e.g. STLTECH/9309) are unpriceable by Angel REST (`"Get live quote failed: SUCCESS"`); they stay surfaced. Decide: subscribe open-position tokens / fix the REST quote. (Note STLTECH wasn't trading 06-10 — manually closed at 582.35, −10.63%.)
3. **Frontend P&L consume-check** — ensure the intraday page reads the backend blended `pnlPct` (not recomputing `exit−entry`) so partial-booked trades display correctly.
4. **Target/RR audit fixes** (see above) — RR gate no-op + target-through-wall.
5. **Adaptive-Stop calibration** — tune `ATR_MULT`/bounds vs `scripts/cf-real-candles.mjs` once a week+ of live A/B data accrues; evaluate the comparison endpoint. Hard-refresh the web to see the new nav item.
6. **S/R audit minors** — round-only levels never clear FLOOR=35 (indices); no-spot → empty evidence.

---

## Service / env state
- App running: `pnpm dev` (turbo) → web :4000, api :4001 (per [[project_app_ports]]); Docker `td-postgres`:5432, `td-redis`:6379.
- A **cloudflared quick tunnel** was started for the Chartink webhook (ephemeral URL; `/webhooks/chartink/<secret>`, secret in `.env`). It dies on restart — re-run `~/bin/cloudflared.exe tunnel --url http://127.0.0.1:4001` ([[project_chartink_tunnel]]).
- **Prisma**: schema evolved via `db push` (from repo ROOT: `npx prisma db push --schema=prisma/schema.prisma`) — never `migrate dev`. New tables `adaptive_stop_*` + intraday partial columns are pushed.
- Untracked junk left uncommitted (tmp-*, backup JSONs, CSVs, `scripts/chartink-monitor.mjs`) — intentionally not in the repo.

## Process notes (preferences honored)
- Build/review work used **teams of Opus subagents** ([[feedback_use_opus_agents]], [[feedback_use_agents]]).
- **Research kept separate from dev** — finished analysis, waited for explicit go-ahead before building ([[feedback_research_before_dev]]).
- A background file-reverter was observed touching *uncommitted* buffers (older handoff flagged it) — committing promptly avoided loss.
