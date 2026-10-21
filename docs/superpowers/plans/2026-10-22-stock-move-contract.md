# Stock big-move model — wiring contract (2026-10-22)

Research result (`C:\Users\AryanKumar\grw-mbm\research\stock-daily\`, `run_er.py wf er0`): pooled daily model over
213 F&O stocks, target **|5-session forward return| > 1.5 × ATR-equivalent**, with the earnings/results calendar
(announced-only, no look-ahead) — walk-forward AUC 0.670, last-3-month 0.655, worst month 0.559 → **GO**.
Direction is NOT predicted. Owner decision: build it **SHADOW** (0 scorecard points), fully automatic nightly in the
application; points only after the self-review loop proves it and the owner approves a proposal.

## Table `stock_move_scores` (schema.prisma `StockMoveScore`, migration `20261022010000_stock_move_scores`)
Written by the MBM Python service (DB role `grw_ai` — add the grants to `deploy/sql/grw-ai-role.sql`), read by the
API. One row per (as_of, symbol, horizon_days=5, threshold_atr=1.5). `bucket` = TOP20 / MID / BOTTOM20 by
`rank_pct` within that day's scored book. Outcome columns filled after 5 sessions.

## Stream S (server: data + model + nightly scoring) — `ai-engine/`, `scripts/`, `deploy/`
1. **Final model:** a ship script that trains the GO configuration on all data through the latest session (same
   features as `build.py` + `earnings_feats.py`, strict announced-only earnings features, LightGBM + isotonic) and
   writes an artifact dir like the MBM models (`models/stock-move/<YYYYMMDD>/`, model + calibrator + feature list +
   metrics json) plus an `ai_models` row (kind `stock-move`, gate GO, inactive until shipped) — follow
   `ai-engine/scripts/mbm_ship.py` / `mbm_monthly.py`. Run the training on the owner's PC (it has the data); ship
   via the existing MBM ship path. Document the command; do not activate in prod yourself.
2. **Nightly job inside the MBM service** (`grw-mbm` container, Python, `ai-engine/src/mbm/…`), 20:15 IST on NSE
   trading days (after the 18:45 self-review), plus a catch-up on boot if today's rows are missing:
   - daily OHLCV for the F&O universe (instruments NFO names with an NSE cash row; exclude test/dummy and indices)
     from **Yahoo** `SYMBOL.NS` (same source as training — the repo has `ai-engine/src/mbm/yahoo.py`), polite
     pacing, incremental cache on the container volume;
   - results calendar: NSE board-meeting / financial-results announcements (same parsing as
     `research/stock-daily/parse_earnings.py`), refreshed nightly, cached;
   - features → score → upsert `stock_move_scores`; fill outcomes for rows whose horizon has passed;
   - fail soft and log one summary line; never block the MBM 5-min loop; respect the 2 GB RAM (stream, don't load
     10 years for 213 names at once — only the lookback the features need).
   - Flag `STOCK_MOVE_ENABLED=observe|off` (default observe = compute + store).
3. Specs/tests in the ai-engine test style; a dry-run CLI that scores one date locally.

## Stream W (app: API + web + self-review) — `apps/api`, `apps/web`
1. **Scorecard (shadow):** in `overnight-scorecard`, the `mood` (expected move) factor for **stock** positions and
   news ideas shows the stock model reading next to the NIFTY line, e.g. `RELIANCE p(big 5d) 0.71 · TOP20 · results
   2026-10-24 in window` — **0 points** while shadow. Allow-list a new tunable in self-review
   `scorecard.stockMove.points` (default 0, bounds 0–1; when 1: long option +1 if TOP20, −1 if BOTTOM20, cap ±1,
   never direction) so turning it on is an owner-approved proposal. Add the proposal rule: after ≥ 20 judged
   STOCK_MOVE rows with TOP20 hit rate ≥ 0.6 and BOTTOM20 ≤ 0.35 → propose points 1.
2. **Self-review:** new verification kind `STOCK_MOVE` (correct = `(bucket=TOP20) == outcome_big` for TOP20/BOTTOM20
   rows; MID → null), in the summary like the others.
3. **Night Report:** "Big-move watch" section — held stocks + news-idea stocks + the top 10 TOP20 names of the day,
   each with p, bucket, results date, last outcome; fail-soft. Web section + vitest.
4. **Agent packet:** add the stock reading to the sentinel packet's existing market-behaviour/expected-move area
   for stock positions (observe-safe, DB-free hot path via a cache refreshed nightly).

Both streams: commit only your own files with explicit pathspecs, no push; tests green; API `tsc` ≤ 174 errors.
