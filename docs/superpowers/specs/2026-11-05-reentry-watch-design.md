# Re-entry watch (2026-11-05) — PAPER ONLY

Owner: "the trade from where we have taken the exit, can we have a watch over it, and decide when we have
the chance to enter, either in the same direction or in the opposite direction."

Motivating prod cases: NIFTY09NOV2624400CE paper exit 10:01 @147.15, then 281 by 13:48;
BANKNIFTY23NOV2656900CE exit 10:07 @745.75, then 1370 by 13:43; CRUDEOIL17NOV268600PE (11-04) exit 18:08,
then crude fell ~450 pts. Each exit was right to protect the trade, but nothing looked again.

## Mode

`REENTRY_WATCH=paper|off`, default **paper**. Anything else ⇒ paper with a logged problem (paper is the
safe value: it can never place a real order). There is no live mode: the module only opens trades through
`EntryEnginePaperService.open` (TradeExecutionService `isPaper: true`), strategy `REENTRY_WATCH`, source
`reentry-watch / paper`. The strategy is in `PAPER_WATCH_STRATEGIES` (the paper watch manages SL / T1 /
square-off and the paper sentinel's AI exits) and in `ISOLATED_PAPER_STRATEGIES` (its own position pool).

## What is watched

Every option position exited **today (IST)**:

| Source | Rows |
|---|---|
| real | `trade_trackers` CLOSED, kind POSITION, NFO/BFO/MCX, symbol ends CE/PE |
| signal-trader paper | `trades` CLOSED paper, strategy `TELEGRAM_SIGNAL_NO_FUNDS`, option |
| entry-engine paper | `trades` CLOSED paper, strategy `ENGINE_ENTRY`, option |

Re-entry trades (`REENTRY_WATCH`) do not start watches of their own — they count against the original's.
One watch per exited position (key `<table>:<id>`). The underlying is the contract's instrument name,
resolved by **tradingsymbol + exchange** (never by token — NSE reuses tokens); only the entry engine's
universe (NIFTY, BANKNIFTY, SENSEX, CRUDEOIL, GOLD, SILVER) is watched, others are recorded once as SKIP.

Original direction: BUY CE / SELL PE = BULLISH, BUY PE / SELL CE = BEARISH.

## Rules (pure: `domain/reentry-rules.ts`)

- **Reference point**: the underlying's 1-minute close at the exit minute (`ref`). The position's best
  underlying point between entry and exit (from the same bars) is recorded as context, not a trigger.
- **Noise unit N15**: ATR14 of 15-minute buckets of the underlying's 1-minute bars (true range only
  within an IST day — the overnight gap is not noise), only bars inside the venue's trading minutes
  (NSE/BSE 09:15–15:30, MCX 09:00–23:55: prod candles_1m holds NSE pre-open index bars 09:00–09:14 whose
  09:00 bar spanned ~1,000 NIFTY points); fallback: exit-discipline `noiseFromBars` on today's 1-minute
  bars × √15.
- **move** = (price − ref) / N15, signed in the original direction's favour.
- **Watch window**: from exit + 10 min (cooldown; after a re-entry closes, the cooldown restarts from its
  exit) until the underlying's venue closes (SessionClock). No signal in the last 30 min of the session
  (the entry engine's `noEntryLastMin`).
- **Caps**: ≤ 2 re-entries per original trade (then the watch is done), ≤ 3 re-entries per IST day
  overall; never while a position on the same underlying is open (a real OPEN tracker on that
  underlying, or an open `REENTRY_WATCH` paper trade).
- **SAME direction**: move ≥ +1 N15 **and** the entry engine's `trendReading` lean = the original direction.
- **OPPOSITE direction**: move ≤ −2 N15 **and** the trend lean = the opposite direction **and** the OI check
  (entry-engine `readOi`, asked for the opposite direction) is not `AGAINST` (NO_DATA / NEUTRAL pass).
- SAME is checked first; both cannot hold at once (opposite signs of move).

## Contract and plan

Exactly the entry engine's: `atmCandidates` (nearest non-expiry-day expiry) → `strikeLiquidity` +
`pickLiquidStrike` (never a dead strike) → `engineContract` (resolved from the master by
name/expiry/strike/type) → fresh LTP → `engineSignal` + `planEngineEntry` (SL −25 % premium, T1 +50 %,
1 lot). BUY CE for a BULLISH re-entry, BUY PE for BEARISH.

## Records, alerts, grading

- Cron every 2 min (IST 09:00–23:59, the SessionClock decides per venue); fail-soft per watch.
- `reentry_watch_decisions`: one row per watch whenever its outcome category changes (SIGNAL, WAIT
  reason, SKIP, CAP, ENDED) — not every 2-min tick. `inputs` holds ref / price / N15 / move / trend / OI /
  counts and, for a SIGNAL, the plan; `trade_id` the paper trade opened. A signal whose open fails is
  recorded with the reason and not retried until the category changes.
- Telegram (`sendOpsAlert`) on every SIGNAL, e.g. "Re-entry (paper): NIFTY CE same direction — NIFTY
  24,452 back above the 10:01 exit point 24,402 with the trend bullish; bought NIFTY24NOV2624450CE @ 152.3".
- Nightly self-review: decision type `REENTRY` in the decision ledger, graded like `ENTRY_TAKE` (chosen
  take vs ₹0, on the contract's 1-minute bars to the session close).

## Replay of 2026-11-05 (prod candles_1m, rules as implemented)

With the shared caps (3/day, one open re-entry per underlying held to the close): SENSEX 78800CE exit
09:31 → SAME 09:43 @ SENSEX 78,803 (later 79,469); BANKNIFTY 56900CE exit 10:07 → SAME 11:27 @ 57,183
(ref 57,015; later 57,848); CRUDEOIL 7950PE exit 09:33 → SAME 12:19 @ 8,212 (crude then rose to 8,412 — a
loser). The day cap was then full, so NIFTY 24400CE (exit 10:01, ref 24,401, N15 ≈ 43) did not fire; on its
own it would have signalled SAME at 12:37 @ NIFTY 24,446 (later 24,579). The daily cap is taken first-come
by exit order — a known limitation.
