# Smart Loss-Recovery Re-entry (gated watch track) — Design Spec

> Date: 2026-06-05
> Status: Approved (design); pending implementation plan
> Scope: `apps/api` watch-monitor module only. Ungated track unchanged.

## Problem

The gated watch track blocks same-day re-entry on any symbol whose last closed trade
today was a loss (`watch.service.ts:226`, the "green-only re-entry gate"):

```ts
const lastPnl = await this.repo.getLastClosedPnlForToken(input.token, todayIst);
if (lastPnl !== null && lastPnl <= 0) throw new TradeLastLossError(input.symbol, lastPnl);
```

This is a blunt rule. It correctly prevents revenge trades, falling-knife re-entries, and
churn — but it cannot distinguish a **dead-cat bounce** from a genuine **stop-hunt
recovery**: a symbol stopped out on a fakeout dip that then resumes a real uptrend. Those
recoveries are currently locked out for the rest of the session.

## Goal

Replace the binary loss-block with a **quality gate**: after a same-day loss, re-admit the
symbol only on overwhelming proof that the uptrend has genuinely resumed — a bar a dead-cat
bounce cannot clear. Keep every existing protection (cooldown, no revenge spiral) intact.

Non-goals: no change to the green path, the Anand tracks, or the ungated track (the ungated
track has no score/factor breakdown, so conditions A/B cannot run there — its green-only gate
stays as-is, preserving it as a clean un-scored baseline).

## The gate

When `lastPnl <= 0` (last same-day close was a loss), admit the re-entry **only if ALL hold**;
otherwise block with a reason naming the failed condition. The existing 45-min R2 cooldown
runs first and unchanged — if still cooling down, block regardless.

| # | Condition | Source |
|---|-----------|--------|
| **A** | `initialScore > 80` (scored factors total 100) | `input.initialScore` |
| **B** | factors **MACD on 5m**, **VWAP relationship**, **RSI on 5m**, **ADX trend strength** each `passed === true` | `input.initialBreakdown` |
| **C** | `currentPrice >= priorEntryPrice` | live quote, else `input.initialPrice`; vs last closed trade's entry |
| **Cap** | this is the **1st** loss-recovery re-entry for the token today | new repo count |

Pass all → **admit at half the normal score-tier capital** (score>80 normally deploys the top
₹2L tier → ~₹1L on the recovery). The green path (`lastPnl > 0`) is unchanged: allowed as
today, full size, subject only to cooldown.

Exact factor `name` strings must be confirmed against `chartink-scoring.service.ts` during
implementation (current names: "MACD on 5m", "VWAP relationship", "RSI on 5m",
"ADX trend strength").

## Components (each small + independently testable)

1. **`evaluateLossReentry(input) -> { allow: boolean; reason: string }`** — a pure function
   (`watch-monitor/services/loss-reentry.ts`) holding the entire A+B+C+cap truth table.
   Input: `{ score, breakdown, currentPrice, priorEntryPrice, priorRecoveryCount }`.
   This is the unit-tested heart of the feature; the service only wires data into it.

2. **`watch.service.createFromAlert`** — on `lastPnl <= 0`, gather the inputs and call
   `evaluateLossReentry`. Allow (flagging a half-size recovery entry) or throw
   `TradeLastLossError` carrying the failed-condition reason. `lastPnl > 0` path untouched.

3. **`WatchRepository`** — two additions:
   - `getLastClosedTradeForToken(token, todayIst)` → `{ pnl, entryPrice } | null`
     (extends today's `getLastClosedPnlForToken` to also return the entry price for C).
   - `countRecoveryReentriesToday(token, todayIst)` → number (backs the cap).

4. **Schema** — `WatchEntry.recoveryReEntry Boolean @default(false)`, set true on admitted
   recovery entries. Backs the cap count and the half-size flag. Applied via `prisma db push`
   (repo convention — never `migrate dev`).

5. **Sizing** — thread `recoveryReEntry` into the execution/sizing path so the deployed
   capital is halved. Exact insertion point confirmed during planning (trade-execution
   sizing for the gated watch track).

## Data flow

```
alert (scored) -> createFromAlert(input{initialScore, initialBreakdown, initialPrice, token})
  cooldown? -> block (unchanged)
  lastPnl = getLastClosedTradeForToken(token).pnl
  lastPnl > 0  -> normal admit (full size)            [green path, unchanged]
  lastPnl <= 0 -> evaluateLossReentry({
                    score: initialScore,
                    breakdown: initialBreakdown,
                    currentPrice: liveQuote ?? initialPrice,
                    priorEntryPrice: getLastClosedTradeForToken(token).entryPrice,
                    priorRecoveryCount: countRecoveryReentriesToday(token),
                  })
                  allow -> admit, recoveryReEntry=true, half tier capital
                  block -> throw TradeLastLossError(reason)
```

## Edge cases (all fail-safe → block)

- `initialBreakdown` missing, or any of the four named factors absent → B fails.
- No prior closed-trade entry price → C cannot be evaluated → block.
- Live quote unavailable → use `input.initialPrice` (the alert trigger price) for C
  (confirmed acceptable).
- `priorRecoveryCount >= 1` → cap reached → block.

## Testing

- **Unit (primary):** `loss-reentry.spec.ts` truth table — admits when all pass; blocks when
  each single condition fails (score ≤ 80, each missing/failed factor, price < prior entry,
  cap reached); reason string names the first failed condition.
- **Repo:** `getLastClosedTradeForToken` returns pnl + entry price; `countRecoveryReentriesToday`
  counts only today's recovery entries for the token.
- **Service:** mocked branch test — green path admits unchanged; loss path delegates to
  `evaluateLossReentry` and admits half-size / throws per its verdict.

## Out of scope / future

- Ungated track smart re-entry (no score data; deferred).
- Complementary to the pending **two-strike stop-hunt** R&D (avoids the bad stop in the first
  place); this recovers when a stop fired anyway.
