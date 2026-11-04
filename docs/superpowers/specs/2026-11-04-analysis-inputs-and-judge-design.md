# Analysis engine: inputs, event days, judge default, gold wiring — design

Date: 2026-11-04. Owner decisions are marked **(owner)**; assistant calls are marked **(call)**. Owner approved the outline in chat ("go ahead").

## 1. Why

On 4 Nov (the US midterm results day) GOLD moved about 3.5k points. A channel call at 11:01 IST, BUY GOLD27NOV26 150000 CE @ 566.5 with targets 600/700/1000, passed every gate. The AI judge SKIPped it at 76% confidence. Its reasons were reward/risk on T1, a neutral trend, "news mixed", and option chain/OI/VIX/expected-move all unavailable. T1 hit in 3 minutes, and the option is now around 865 (+53%, about ₹30k on one lot).

What prod shows:
- **The news reader frames event days wrongly.** 19 election stories and 12 gold stories were read today. Almost all came out NEUTRAL LOW, "no Indian impact", because each story is judged on its own for direction. An election is a *big-move-expected* day with no known direction, and the reader has no way to say that.
- **The judge skips too much.** Over 21 days of channel calls the judge SKIPped 65 of 70. Of the scored skips, 11 were right (avoided −₹9,281 per lot) and 13 were wrong (missed +₹34,602 per lot). GOLD in that table is still counted at 1/100th of its real value. TAKEs went 3 right (+₹7,010) and 1 wrong (−₹1). Missing data pushes it to SKIP.
- **Gold is blind.**
  - No GOLD futures 1m bars are stored.
  - No GOLD/SILVER option chain exists in oi_snapshots (`oi_check NO_DATA`).
  - The entry engine universe is NIFTY, BANKNIFTY, SENSEX and CRUDEOIL only (`entry-engine/domain/engine-inputs.ts` ENGINE_UNIVERSE).
  - Entry sizing understated GOLD risk 100× ("risk ₹144.5" against about ₹14,450 real; signal-trader gate lot sizing has no `contractValueFactor`).
  - The live order would have been blocked anyway: `judge.liveGateBlocked = risk_manager`.
- **The engine's news is often empty.** It counted no news on 58 of 113 checks today, because its per-story lookback is 60 minutes and stories must be tagged to the underlying.

Owner goal **(owner)**: the engine identifies these factors itself and makes the decision. No manual checking.

## 2. Goals

1. **Event days are known automatically.** A calendar of scheduled high-impact events (US elections, FOMC, US CPI/NFP, RBI policy, Union budget, India CPI, OPEC meetings) feeds the judge, the entry engine and the exit packet as `eventDay: {name, at, affects: [underlyings], expectMove: true}`. Nobody maintains it by hand. The builder picks the source: a curated recurring-schedule generator in code (FOMC/RBI/NFP/CPI dates are published a year ahead) plus a free fetch if one is reliable. A missing calendar is stated as absent, never as "no event".
2. **The news reader can tag "big move expected"** (EVENT_RISK / volatility) separately from BULL/BEAR, with the affected underlyings: GOLD, SILVER, CRUDEOIL and the indices for US/global macro. It is stored on news_impacts and used by the judge and the engine.
3. **The judge's default flips to TAKE (owner approved).** The judge takes a channel call unless there is concrete evidence against it: price already past T1/target, the stop already broken, an entry far outside tolerance, an expiry-day or illiquid contract, or a hard risk. Missing data (chain, VIX, expected move) and "mixed news" are never by themselves a reason to SKIP. They are stated as absent, and on an event day they count for nothing. The nightly `ai_check` fair scoring continues and reports the judge's skip cost.
4. **Gold and silver are wired end to end.**
   - **Live data:** GOLD and SILVER near-month futures go on the market hub's pinned lines (1m bars all session). Their option chain snapshots go into oi_snapshots, so oi_check and the judge get a chain.
   - **Entry engine:** GOLD and SILVER join `ENGINE_UNIVERSE`, still in paper (ENTRY_ENGINE=paper). That includes the news match maps (`entry-decision.ts` NEWS_MATCH, `news-theme.ts` headline/sector/instrument maps: gold/bullion/Comex/"yellow metal"; silver).
   - **Entry sizing:** signal-trader gate lot sizing and `riskRupees` multiply by `contractValueFactor` (@td/shared).
   - **GOLD loss limit ₹7.5k (owner).** The hard loss exit (`HARD_LOSS_EXIT_RUPEES` path, `exit-discipline/hard-floor.ts` hardLossTrip) and the gate's risk cap use ₹7,500 for GOLD-underlying positions. Everything else stays ₹2k→₹3k. This is configurable per underlying, e.g. env `HARD_LOSS_EXIT_RUPEES_BY_UNDERLYING=GOLD:7500`.
   - **Full GOLD, not GOLDM (owner).**
   - **Risk manager block:** find why the account risk manager would have blocked the live GOLD entry today (`liveGateBlocked=risk_manager`) and fix it if it's the unscaled factor or a wrong cap. If it's genuinely insufficient funds, report it and leave the cap alone.
5. **A daily inputs health alert** (prod cron + Telegram). For each watched underlying, during its session, it checks for missing 1m bars, missing chain snapshots, the news pipeline being silent for more than N minutes, and the entry engine's news input being NO_DATA across a whole session. It sends one alert per problem per day, so a missing input surfaces the same day.

## 3. Non-goals / anti-goals

- No new direction model. Direction remains a coin flip in every test; event days predict move SIZE, which favours long options in the channel's direction.
- No manual steps for the owner.
- The entry engine is not made live. It stays paper until it has a scored track record (memory: entry-engine-paper).
- Don't bypass `AI_AUTO_EXIT_DAILY_CAP`, the kill switch, or the account risk manager's real limits.
- Failure if: an input silently goes missing again with no alert, or the judge's prompt change raises the take count but the scoring stops recording skips/takes.

## 4. Constraints

- Signal trading is LIVE: SIGNAL_MAX_LOTS=1, 2/day, options only. The judge change means more real orders. Ship it behind a flag (e.g. `SIGNAL_JUDGE_DEFAULT=take|skip`), default `take` **(call; owner approved the behaviour)**.
- Prompt changes bump the prompt version and update golden snapshots.
- Feed slots are scarce (30 tokens). Pinning GOLD and SILVER futures costs 2 slots; the chain snapshot must use REST, not the feed.
- Angel REST limit is ≤ 10 req/s and the historical gate is 350 ms.
- Commit with explicit pathspecs; never push non-main; deploy after 15:35 IST.
- The C: drive has very little space: run targeted jest with `--no-cache`, never the full suite in parallel with others.

## 5. Left to the builder

- Event-calendar source and storage.
- The news-reader schema for EVENT_RISK.
- The exact judge prompt wording.
- Pinning mechanics.
- Health-check thresholds.
