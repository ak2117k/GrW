# Re-entry watch — LIVE mode (design)

Date: 2026-11-23 · Status: DRAFT, awaiting owner approval · Builds on
`2026-11-05-reentry-watch-design.md` (paper only). Owner decisions quoted as such.

## 1. Intent

The re-entry watch looks again at an option position after it is exited, and re-enters when the
underlying moves on (same direction) or turns (opposite direction). Since 2026-11-05 it has only
opened PAPER trades: 34 re-entries, 18 wins, +₹41,790 gross (5–20 Nov), most of it from three trades
(GOLD full lots +₹32.7k). Re-entries of the owner's REAL exits: 6, net about −₹330.

The owner wants re-entries of his real trades to place **real orders**, inside fixed limits
(owner, 2026-11-23: "design the live mode and tell me first what are the limits"; then
"2 add reversal also, 5 max 4, 7 three losses, 11 add for everyone"; daily cap "6").

## 2. Goals, non-goals, anti-goals

Goals
1. `REENTRY_WATCH=live`: a re-entry of a **real** exit that passes every limit in §3 is placed as a
   real LIMIT order through the signal trader's live order path; everything else stays paper exactly
   as today.
2. Every live re-entry is a normal real position afterwards: the sentinel's AI exits, the hard floor,
   both chart checks (now `act`), the ₹2k / ₹3.5k loss exits, the owner's manual exit.
3. Every decision (live, paper, blocked-by-limit) is recorded with the limit that decided it.

Non-goals
- Changing the re-entry rules themselves (when a SAME / OPPOSITE signal fires, contract choice,
  SL −25 % / T1 +50 % plan) — unchanged from the paper design.
- Live re-entries of PAPER exits (signal-trader paper, entry-engine paper). They stay paper.
- New exit logic.

Anti-goals
- A live order the limits did not allow (any limit unreadable ⇒ paper, never live).
- A chain: a live re-entry's own exit starting a fresh watch with fresh caps.
- A silent block: an approved live re-entry dropped without a stored reason (the open fix-ticket
  pattern for risk_manager blocks — see fix_tickets "risk_manager blocks approved live calls").
- A second broker login over the live feed.

## 3. The limits (owner-approved values)

| # | Limit | Value |
|---|---|---|
| 1 | Which exits may re-enter LIVE | Only the owner's **real** option positions (`trade_trackers` CLOSED, NFO/BFO/MCX, CE/PE). Paper-source watches stay paper. |
| 2 | Direction | **SAME and OPPOSITE** (owner added reversal). |
| 3 | Size | **1 lot** (`SIGNAL_MAX_LOTS`). MCX: if the full lot fails the risk check (#4) or funds, the **mini** (GOLDM / CRUDEOILM / NATGASMINI, signal-trader `mini-swap.ts`), lots = min(cap, funds, `miniMaxLots`). |
| 4 | Risk check before the order | (entry − SL) × qty ≤ **₹2,000** (`HARD_LOSS_EXIT_RUPEES`, per-underlying override honoured). Fails ⇒ try mini (MCX) ⇒ else paper with reason `RISK_OVER_LIMIT`. |
| 5 | Live re-entries per original trade | **≤ 4** (paper's own per-watch cap is raised to 4 for live-eligible watches; paper-source watches keep 2). |
| 6 | Live re-entries per IST day | **≤ 6**. |
| 7 | Loss stop | After **3 losing live re-entries** (closed, net P&L < 0) in an IST day, no more live re-entries that day. |
| 8 | Daily real-money stop | Shares the signal trader's `SIGNAL_DAILY_LOSS_STOP` (₹10k default): when today's realised real-money loss (signal trades + live re-entries) reaches it, no live re-entries. |
| 9 | AI must agree | The AI entry judge (`EntryJudgeService`, already asked for every re-entry SIGNAL) must say **TAKE**; anything else ⇒ paper. |
| 10 | Time | NSE/BFO **09:45–15:00** IST; MCX **09:45–23:00**; never in the venue's last 30 min (existing rule). |
| 11 | Underlyings | **All** of the watch universe: NIFTY, BANKNIFTY, SENSEX, CRUDEOIL, GOLD, SILVER (owner: "add for everyone"). SILVER has no usable mini (different expiry) so a full SILVER lot that fails #4 goes paper. |
| 12 | Exits | Same as every real position (§2 goal 2). |
| 13 | Funds | The signal trader's funds check (`funds.ts`); short ⇒ mini (MCX) ⇒ else paper `NO_FUNDS`. |
| 14 | Switches | Live only when `REENTRY_WATCH=live` **and** `LIVE_TRADING_ENABLED=true` **and** the kill switch is off **and** `coreEntryAllowed` (risk wall) passes — all re-checked inside the broker session right before the call, like signals. |

Also unchanged from paper: never while a position on the same underlying is open; 10-minute cooldown
after an exit; one watch per exited position.

Worst realistic day under these limits: three losing live re-entries ≈ −₹6k (≈ −₹10.5k if the
chart check holds each loss to the ₹3.5k absolute cap), bounded again by the shared ₹10k daily stop.

## 4. Design

### 4.1 Mode

`reentry-watch.config.ts`: `ReentryWatchMode = 'off' | 'paper' | 'live'`. Unknown values still fall
back to **paper** (the safe value). `live` changes only what happens to a SIGNAL from a real-source
watch that clears §3; every other path is byte-for-byte today's.

Limit values come from env with the §3 defaults (`REENTRY_LIVE_MAX_PER_TRADE=4`,
`REENTRY_LIVE_MAX_PER_DAY=6`, `REENTRY_LIVE_MAX_LOSSES=3`, `REENTRY_LIVE_FROM_IST=09:45`,
`REENTRY_LIVE_NSE_UNTIL_IST=15:00`, `REENTRY_LIVE_MCX_UNTIL_IST=23:00`); size, risk cap, funds,
mini and the daily stop reuse the signal trader's settings so there is one place for each.

### 4.2 Decision flow (one SIGNAL)

```
watch → SIGNAL (rules unchanged) → AI entry judge
  ├─ not TAKE                                  → paper (as today) / no trade (as today)
  └─ TAKE
       ├─ mode != live or source != real        → paper (as today)
       ├─ liveGate(§3 #2,5,6,7,8,10,11)         → blocked → paper, reason = the limit
       ├─ size & risk & funds (#3,4,13, mini)   → none fits → paper, reason
       └─ place LIVE via SignalExecutorService-style executor (LIMIT, ordertag, claim-first)
            ├─ PLACED / filled   → real position; tracker linked to the watch (§4.4)
            ├─ REJECTED (funds)  → paper fallback, reason = broker text
            └─ UNCERTAIN         → resolved from the order book by tag (SmartAPI never rejects)
```

`liveGate` is a **pure** function (`domain/reentry-live-gate.ts`) over: mode, source, direction,
counts (per trade, per day), today's live losses, today's realised real-money P&L, IST time + venue,
underlying. It returns `{ live: true }` or `{ live: false, limit, detail }`. Any missing input ⇒
`{ live: false, limit: 'UNKNOWN_INPUT' }` (anti-goal: unreadable ⇒ paper).

### 4.3 Placing the order

Reuse the signal trader's live plumbing rather than a new path:
- the owner's borrowed broker session (`OwnerBrokerSessionProvider`, never a second login);
- `placeOrderClassified` with an `ordertag` derived from the re-entry decision id;
- claim-before-send (unique decision id) — at most once, never re-sent;
- LIMIT at the fresh LTP plan price, cancelled if unfilled after `SIGNAL_FILL_WAIT_SEC`;
- `isLiveTradingEnabled()` + `coreEntryAllowed(...recheck)` re-checked last thing before the call.

The builder chooses between calling `SignalExecutorService.place` with a re-entry `PlaceInput`
(preferred if its row/table semantics fit — `signal_orders` keyed by decision id) or extracting its
core into a shared executor; behaviour must be identical for signals either way.

### 4.4 Linking, so caps hold and nothing chains

- The live order's ordertag and the decision row carry the watch key (`reentry-of:<watch key>`).
- When the broker position appears as a `trade_trackers` row, it is linked to the watch (by ordertag
  / tradingsymbol + time). When that tracker CLOSES it does **not** start a new watch; it counts as a
  re-entry of the original (per-trade cap #5) and, if net P&L < 0, as a loss for #7.
- `reentry_watch_decisions` gains `mode='live'` rows with the order id / tag, and blocked rows store
  `limit` + `detail` (e.g. `MAX_PER_DAY 6/6`, `LOSS_STOP 3`, `RISK_OVER_LIMIT ₹2,640 > ₹2,000`).

### 4.5 Owner visibility

- Each live re-entry placed → one owner alert (existing owner-alert port; note Telegram is currently
  unconfigured on prod, so these land in logs until the owner sets the bot — memory
  `telegram-alerts-unconfigured`).
- Loss stop (#7) or daily stop (#8) reached → one alert per day.
- The night report lists live re-entries (count, P&L) and live-eligible signals sent to paper by
  which limit.

## 5. Rollout

1. Ship with `REENTRY_WATCH` unset (= paper). Prod behaviour unchanged. Tests + replay (§6).
2. Owner's go, markets closed: `REENTRY_WATCH=live`, recreate the API.
3. First live days: watch every live re-entry; compare with the paper record.
Rollback: `REENTRY_WATCH=paper` + recreate (~1 min). Open live re-entry positions keep being
managed by the normal exit stack.

## 6. Testing

- Pure `liveGate`: every limit at its boundary (4th vs 5th per trade, 6th vs 7th per day, 3rd loss,
  daily stop reached, 09:44 / 09:45 / 15:00 / 23:00 / last-30-min, paper-source, SILVER no-mini,
  unknown input ⇒ paper).
- Size/risk/funds/mini: risk ≤ ₹2k full lot; GOLD full lot over ⇒ GOLDM; SILVER over ⇒ paper.
- Placement: claim-once (duplicate decision ⇒ nothing sent), LIVE_TRADING_ENABLED off at the last
  moment ⇒ nothing sent, kill switch ⇒ nothing sent, funds reject ⇒ paper fallback, uncertain ⇒ tag
  lookup. Fake broker session only — no real order in tests.
- Linking: a closed live re-entry tracker does not start a watch; counts toward #5 and #7.
- Mode `paper` / unset: existing re-entry specs pass unchanged.
- Replay: run the 5–20 Nov watch history through `liveGate` + sizing and report which of the 34
  re-entries would have gone live, at what size, and their P&L at real lot sizes (GOLD → GOLDM).

## 6a. Settled after the builder check (2026-11-23) — these override anything above

1. **Risk cap #4 is a fixed ₹2,000 per order, ALWAYS enforced** (`REENTRY_LIVE_RISK_RUPEES`, default
   2000). It ignores `SIGNAL_RISK_CAP_GATE`, `SIGNAL_MAX_LOSS_PER_TRADE` and the per-underlying
   override (GOLD 7,500). GOLDM / CRUDEOILM / NATGASMINI use the same ₹2,000. The signal trader's live
   filters (`SIGNAL_LIVE_UNDERLYINGS`, `SIGNAL_LIVE_KINDS`, `SIGNAL_MAX_LOTS`) do NOT apply — §3 replaces them.
2. **Eligible exits = every real option position** (`exitsSince` origin REAL), manual AND signal-trader
   live — the owner asked about "re-entry on the real money trades". EXCEPT trackers that are
   themselves live re-entries (they never start a watch; §4.4). The per-day cap 6 bounds the total.
3. **Caps (all counted from the DATABASE, never from in-memory maps; in-flight orders — CLAIMED /
   PLACED / UNCERTAIN / filled — count):**
   - (a) #5: a real-source watch allows **≤ 4 re-entries in total** (live + paper fallback together).
   - (b) a paper fallback (blocked by a limit / funds / reject) uses one of those 4.
   - (c) the **live day cap (6) counts live orders only**, and a live-eligible signal is NOT blocked by
     the paper day cap (5) or the paper per-original cap (2) — those keep applying to paper-source watches.
   - (d) live re-entries DO count for the cooldown, the per-watch cap and "never while the same
     underlying is open" (which must see minis — GOLDM/CRUDEOILM/NATGASMINI — and in-flight orders).
4. **#8 daily stop** reuses the signal trader's `signalLossToday` + `SIGNAL_DAILY_LOSS_STOP` exactly as
   signals use it today (live re-entry orders go through the signal executor, so their trackers are
   counted, and their losses also stop signal trades — one shared real-money stop, as approved).
   Manual trades are not counted (unchanged).
5. **Loss for #7** = a closed live re-entry whose P&L from its OWN order fills (entry fill from the
   order book by our tag, exit fill from the tracker's exit) minus charges (`trade-charges.ts`) is < 0.
   Not the tracker's `avgnetprice`, which can mix an earlier same-day round trip on the same symbol.
   Re-entering the same contract the same day is allowed.
6. **Size**: 1 full lot; MCX mini fallback lots = min(⌊₹2,000 / per-lot risk⌋, funds, `SIGNAL_MINI_MAX_LOTS`),
   and ≥ 1 or it goes paper. Never more than 1 full lot.
7. **#9 "TAKE" = EntryJudgeService decision ENTER, with the judge mode `on` (prod default) and a
   successful call.** observe/off/errors ⇒ paper.
8. **Linking**: ordertags stay the signal executor's 20-char form; the watch key lives on the decision
   row / `signal_orders` (a `source`='reentry' + `reentry_watch_key` / decision id), and the tracker is
   linked through `signal_orders.tracker_id`.

## 7. Builder's calls (owner may override)

- Reuse the signal trader's executor and funds/mini code instead of a new order path.
- Live-eligible watches get the per-trade cap 4 for live; paper-source watches keep 2.
- "Loss" for #7 = closed live re-entry with net P&L (after charges) < 0.
- Time window start 09:45 for MCX too (same as signals' `SIGNAL_LIVE_FROM_IST` today).
