# Handoff — 2026-11-24 — session-only candle reads (pre-open bar fix, root level)

## Live on prod (deployed 13:21 IST 2026-11-24, NSE holiday so no close-wait)
- `37d1eff2` NATURALGAS in entry engine + re-entry; MCX options ATM from the future they settle to. NG re-entries are real orders (₹2k limit, mini fallback). SILVERM still maps to full SILVER — owner hasn't said exclude or keep.
- `067c62f8` chart-reading fix: signal judge trend tag + exit chart check read session bars only.
  Added `apps/api/src/modules/exit-discipline/session-bars.ts` (venueSession NSE/NFO/BSE/BFO 09:15–15:30, MCX 09:00–23:55; sessionOnlyBars; rollToSessionBuckets).

## Root cause (verified on prod 2026-11-23)
`candles_1m` stores every tick-built minute of NSE/BSE lines: flat copies from ~02:00, the 09:00–09:08 pre-open auction
(BANKNIFTY 23-Nov 09:00 bar = 1,100-pt range that never traded), flat bars to 09:14, flat bars after 15:30 (~170/day).
Any reader aggregating 1m → 5m/15m/1h/1d without a session filter gets junk bars (fake ranges, inflated ATR, diluted EMA/MACD).

## IN PROGRESS — owner-approved, UNCOMMITTED, UNTESTED as a whole
"Fix the shared database read": filter at the root so every reader gets session-only bars.
Two agents worked on it; both stopped (session end, then the 5-hour usage limit). Last agent's final step was
"add tests: multi-timeframe reader hubBars SQL + staleness".

Working-tree changes from this task:
- NEW `market-hub/candles/session-sql.ts` — `sessionMinuteFilter(exchange, column)` SQL fragment built from session-bars venueSession
- `market-hub/candles/candle-repository.ts` — read() (1m) and readBucketed() apply the filter; NEW `candle-repository.spec.ts`; NEW `market-hub/testing/captured-sql.ts`; `memory-candle-repo.ts`; `test/sp1-m2/candle-repository.int.spec.ts`
- `exit-noise/exit-noise.repository.ts` + NEW spec
- `intraday-carry/intraday-carry-score.service.ts` (first session bar, gapPct) + NEW spec
- `self-review/repositories/verification-sources.repository.ts` (minuteBarsHL) + NEW `verification-sources.minute-bars.spec.ts`
- `signal-trader/repositories/signal-trader.repository.ts` (judge noise N1/N5, extremeSince) + NEW `signal-trader.session-bars.spec.ts`
- `trade-sentinel/services/multi-timeframe-reader.service.ts` (+spec), `multi-timeframe.ts` staleness (+ `multi-timeframe.stale.spec.ts`)

NOT related to this task (leave alone / separate decision): `apps/api/Dockerfile` (deps-first layer caching, dated 11-19),
`apps/api/src/modules/research/` (odds engine, 11-23), `research/*`, `docs/chart-reading/`, `docs/reviews/`.

### Still to do
1. Verify readers not yet touched in the diff: `trade-core/intake/entry-market.ts` candlesFor/atr() (entry stop sizing — today's 1d included pre-open range), `trade-core/intake/gate-evaluators.ts` (adaptive-stop 15m pivots, MACD, RSI), `trade-sentinel/adapters/tick-source.adapter.ts` ~:597, `signal-oi-check.service.ts` ~:121. May already be covered by the repository fix — check which path each uses.
2. Check callers of readBucketed pass venue-open origin (NSE 09:15 = 555, MCX 09:00 = 540) and that today's 1d is from session minutes only.
3. Confirm the pre-open outlook (`market-hub/pre-open-outlook.repository.ts`) still reads pre-open minutes via its own SQL (the doc comment in candle-repository claims no opt-out is needed — verify).
4. Run: `cd apps/api && npx jest src/modules/market-hub src/modules/trade-core src/modules/signal-trader src/modules/intraday-carry src/modules/self-review src/modules/exit-noise src/modules/trade-sentinel src/modules/sentinel-executor src/modules/exit-discipline src/modules/entry-engine src/modules/reentry-watch` (known flaky: date-dependent expiry test in market-hub.service.spec); `npx tsc --noEmit -p tsconfig.json` (~178 pre-existing errors elsewhere, zero in changed files); web `cd apps/web && npx tsc -b && npx vitest run` (charts).
5. Impact numbers read-only on prod for 2026-11-23, NIFTY + BANKNIFTY: old vs new 15m ATR14, 1d high/low, entry-market ATR used for stop sizing.
6. Show owner, get go, commit with explicit pathspecs (never `-a` — unrelated files in tree), push = deploy (guard waits for 15:35 IST on NSE days).

## Then: accuracy comparison (owner asked: "does chart-reading accuracy increase?")
Old vs new on the same historical cases:
- Exit chart check: ~100 real exits since 2026-11-01 — when "against", did price keep going against (exit right)? when "intact", did it come back? Use +30/+60 min prices.
- Signal judge trend tag: ~260 past signals with paper/live results — do WITH-trend beat AGAINST-trend more after the fix?
- Entry stop size (ATR): how often stop hit then price recovered, old vs new stop size.

## Open owner decisions
- SILVERM: exclude or keep mapped to full SILVER?
- Chart check: loss side back to observe; profit side not on expiry-day options — needs yes.
- Judge wording: expiry day counts as evidence only when the contract is also illiquid — needs yes.

## Context notes
- Previous full transcript: `~/.claude/projects/C--Users-AryanKumar-Desktop-GrW/da610cda-b703-4916-8b19-4a5a971d52e3.jsonl` (use `/resume`).
- Prod: ssh -i ~/.ssh/grw_oracle root@157.10.98.70; DB `docker exec grw-postgres psql -U grw -d grw`.
- Open fix queue (session-start hook): top items are risk_manager / sl_side blocks dropping approved live calls without recording limit/exposure or alerting.
