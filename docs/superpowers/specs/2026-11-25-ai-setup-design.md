# AI setups from channel information — info → verify → setup → paper → live

Date: 2026-11-25 · Status: DRAFT for owner approval · Area: `message-reader`, `entry-engine`, `signal-trader`

## 1. Intent — why

Owner (2026-11-25), on "Dabur breakout" from *Stock Gainers*: "its part of the AI to process and take use of
data, verify the data, and bring out meaningful insight from it like can we plan any setup for it, which
will be the best setup for it". Then: "(c), with real trade — that's where the AI is coming; if the data
and everything is in favour, it should go". Owner accepted paper first (~20 graded setups, 1–2 weeks),
then live with OK, and picked approach B.

Worked example (14:18 IST, 2026-11-25): DABUR broke its 60-day high 403 at the open; posted 14:11 at ~431
(+8%, 2.9× daily ATR, volume 7× the 20-day average). Verdict: breakout real but late. Setup: don't chase;
buy the pullback 424–426 (13:00 support), SL 419.5, T 433.5 / 440; or a 15m close above 433.6 → entry
~434, SL 427, T 445. Instrument: Dec 430 CE or the future, checked for liquidity. Catalyst unknown → check
news first.

## 2. Goals, non-goals, anti-goals

**Goals**
- G1. For every reading with a **tradeable, CONFIRMED** claim (instrument or sector scope, BULL/BEAR,
  intraday or days), a setup AI decides **NO_TRADE (with reason) or a complete setup**, within ~60 s of
  the reading.
- G2. A setup is concrete: instrument (cash/future/option: strike + expiry), side, entry type (pullback
  limit / breakout trigger / now), entry zone, SL, targets, validity window, size (1 lot), reasoning with
  the numbers behind it, confidence.
- G3. Every setup is **shown to the owner** (Market notes screen: setup card) and **paper-traded**
  through the existing entry path as a wait-for-price entry.
- G4. Every setup is **graded nightly** (paper P&L net of charges; would-have-filled; hit SL/target).
- G5. **Live** only after ≥ 20 graded setups with positive net and the owner's OK; then 1 lot, inside every
  existing cap, daily loss limit and kill switch.

**Non-goals**: replacing the signal judge for channel *calls*; selling options; sizing above 1 lot.

**Anti-goals**: chasing (entries far from the verified level); a setup without numbers behind it; a live
order from an unproven setup source; the setup AI slowing the message reader.

## 3. Constraints

- CLAUDE.md: new strategies start in paper; hard limits above everything; Angel rate limits.
- Reader packet today lacks stock price/levels (DABUR reading was NOT_CHECKABLE: no spot, structure
  skipped). The reader packet must gain a cheap **quote block** for named stocks (LTP, day high/low,
  previous-day high/low/close, today's volume vs 20-day average, last 15m bars) — prerequisite.
- Owner rules: nothing decided on 1m bars (15m smallest); daily + 15m + option-chain OI view.
- Broker session is scarce (30 feed slots, 350 ms historical gate): the setup AI's data fetch is capped
  (concurrency 2) and time-boxed.
- Research memory: direction prediction is near coin-flip on most methods → grading before trust is the
  point, not a formality.

## 4. Approaches considered

| | Approach | Trade-off |
|---|---|---|
| A | Reader builds the setup in its own call | One call, but slows every message and the reader's packet can't hold chain/news |
| **B (chosen)** | **Separate setup AI, triggered only by a CONFIRMED tradeable claim** | Reader stays fast; richer data for the few posts that matter; one more AI call (~5–15/day) |
| C | Feed claims into the entry engine's code rules | No new AI, but can't reason "real but late — buy the pullback" |

## 5. Design

### 5.1 Flow
reading stored (READ, claim CONFIRMED, scope INSTRUMENT/SECTOR, bias BULL/BEAR, horizon INTRADAY/DAYS,
channel not muted) → enqueue setup job (dedupe: one per underlying per 30 min) → build setup packet
(time box 8 s) → setup AI (Opus 5.5, effort high, strict JSON, job `setup.build`) → validate → store
`ai_setups` row → if SETUP: show card + arm a **paper** entry via the entry engine's paper path as a
trigger (pullback limit or breakout trigger, valid until `validUntil`) → nightly grade.

### 5.2 Setup packet
Daily bars (60 sessions): highs/lows, ATR14, volume vs 20d; 15m bars today + previous session; the
verified claim + its evidence; option chain for the nearest liquid expiry (strikes ±5 from ATM: LTP, OI,
volume, spread); futures quote if F&O; news of the last 60 min for the underlying; channel's claim-accuracy
record (when scoring exists) and call record; time to close; today's desk state (trades today, P&L) — the
watcher can veto later.

### 5.3 Setup AI reply (strict JSON)
`decision: NO_TRADE | SETUP`, `reason`, and for SETUP: `instrument {kind: CASH|FUT|OPT, symbol, strike?,
optionType?, expiry?}`, `side: BUY|SELL` (options: BUY only), `entry {type: LIMIT_PULLBACK |
BREAKOUT_TRIGGER | MARKET_NOW, low, high, trigger?}`, `sl`, `targets[]`, `validUntil` (IST time, ≤ session
end for intraday), `confidence 0–100`, `evidence[]` (packet numbers, same validation as the reader:
every cited value must exist in the packet). Code checks: SL on the protective side; reward:risk to T1 ≥
1.2; entry within 1.5 × ATR15m of the verified level (anti-chase); option liquidity (spread ≤ 2%, OI ≥
threshold); otherwise downgraded to NO_TRADE with the failed check.

### 5.4 Paper → live
- `AI_SETUPS=off|paper|live`, default off; rollout: `paper`.
- Paper uses the existing entry-engine paper path (`isPaper: true`, strategy `AI_SETUP`), so the paper
  sentinel manages exits like other paper trades.
- `live` additionally requires: ≥ 20 graded setups, net after charges > 0, owner OK, and is still 1 lot,
  every cap, daily max loss, kill switch, watcher pause (when built).
- Live orders go through the signal-trader executor path (same gates, pre-send price check, re-arm).

### 5.5 Owner visibility
Setup card on the Market notes screen: the claim, verdict, setup (or NO_TRADE + reason), paper status
(waiting / filled / exited, P&L). Ops alert on each SETUP (when Telegram alerts are configured).

### 5.6 Grading
Nightly: for each setup — filled or not (entry zone touched before validUntil on 15m bars), result (SL /
T1 / T2 / time exit), net ₹; per-channel and per-claim-type tallies; NO_TRADE decisions also graded
("what if" at the verified level) so we learn whether the AI's caution is right.

## 6. Decided by the owner
- Approach B; paper first (~20 graded setups), then live with owner OK; trades when data favours.
- Show every setup to the owner and paper-trade it (option c).

## 7. Calls made in this design (owner to check)
- Prerequisite: reader packet gains the stock quote block (fixes DABUR NOT_CHECKABLE).
- Opus at high effort for setups; one per underlying per 30 min.
- Anti-chase rule: entry within 1.5 × 15m ATR of the verified level, else NO_TRADE.
- Options bought only; 1 lot; reward:risk ≥ 1.2 to T1.
- Live gate: ≥ 20 graded, net > 0, owner OK.

### Settled after the builder check (calls, owner to check)

- **v1 instruments: option BUYS only** (index, stock and MCX options), 1 lot. Cash and futures are out
  of v1 (the live signal path is F&O/MCX options; 1 lot of a stock future risks far more than the ceiling).
- **Levels are on the underlying** (that is how the analysis is done): entry zone, entry trigger, SL and
  targets are underlying prices; the setup also names the option. The entry waits on the **underlying's**
  price (market-hub ticks, a small new setup-trigger store — not fake SignalDecision rows); exits are
  armed as **underlying price triggers** through the existing TriggerWatch/level-executor path (tighten-only).
- **Who exits / what is graded:** the setup's SL and targets are hard exits (underlying triggers); the
  paper sentinel, target trailing and the catastrophe floor also apply, exactly as they would live. The
  live gate uses the **actual paper P&L** (what live would get); the grade also reports the plan-only
  result (SL/T1/T2 on 15m bars) to show whether the AI's plan or the management adds value.
- **SL must fit the loss ceiling:** a setup whose SL distance × option delta × lot implies a loss above the
  class ceiling (Plan 1) is downgraded to NO_TRADE ("stop too wide for 1 lot").
- **Anti-chase rule:** BREAKOUT_TRIGGER and MARKET_NOW entries must be within 1.5 × the 15m ATR of the
  level the setup cites, and that level must be a number present in the packet (day high, prior high,
  15m swing, VWAP); LIMIT_PULLBACK entries must sit below current price for a BUY (above for a put's
  underlying view) — they wait for the market to come back, so they cannot chase. The DABUR example
  passes (pullback 424–426 below LTP 431).
- **v1 is intraday only:** validUntil ≤ 15:15 IST (NSE) / 23:00 (MCX); nothing carried overnight; DAYS-horizon
  claims produce at most an intraday setup or NO_TRADE.
- **No double positions:** no setup when the post itself is a CALL, or when a signal trade or another
  setup is open or pending on the same underlying. AI setups have their own cap (3 per day, paper and
  live) and also count toward the desk's daily max loss.

## 8. Left to the builder
Exact prompt; liquidity thresholds; table schema (`ai_setups`); setup card layout; how SECTOR claims map
to an instrument (sector index future/ETF or skip in v1).

**Owner 2026-11-25 ("go with the recommendation"):** stock-option ceiling stays ₹3,000 for AI setups; the
setup AI picks the strike so SL distance × |delta| × lot ≤ ceiling; reward:risk AND ₹ risk are measured from
the WORST fill (zone top for a bullish pullback, zone bottom for bearish; max(high, trigger) / min(low,
trigger) for breakouts).
