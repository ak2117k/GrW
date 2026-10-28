# Paper exit shadow — live exit rules recorded on paper trades

Date: 2026-10-28 · Owner request · Status: approved in chat, design for build

## Why

Paper trades (signal-trader, `TELEGRAM_SIGNAL_NO_FUNDS`, learning mode) run with **no stop**: they exit
at T1 or the intraday square-off. That tells us whether the *call* was right, but nothing about *when to
exit*. Live trades are exited by a software stop trigger and the trade sentinel (AI exit judge). The
owner wants paper trades handled "the way we handle live trades" so we collect data on exits and can
improve the exit rules.

## Decision (owner + my call)

- **Record in parallel, never act.** The paper trade itself is unchanged (no stop, T1 / square-off):
  that is the "held" baseline. Every live exit rule runs beside it and records when, at what price and
  why it *would* have exited. Owner asked my view; my call, because an exit that really closes the
  paper trade destroys the counterfactual we need to judge it.
- **AI sentinel included now** (owner's choice), not deferred.

## Goals

1. For every paper trade, a row per exit rule: first would-exit time, price, reason, and ₹ vs the
   held result.
2. The AI sentinel judges open paper positions with the same packet and judge it uses live, verdicts
   recorded per look.
3. Nightly self-review grades each rule / AI verdict against holding, so live exit tunables can be
   changed on evidence.
4. Visible on the paper trade (Journal reason / Signals card) as one line.

## Non-goals / anti-goals

- **Never an order, never a paper close from a shadow rule.** A shadow rule that changes a paper
  trade's outcome is a failure even if it "works".
- **Never take a live sentinel slot** (`SENTINEL_MAX_WATCHED` = 5 live positions) or delay a live look.
- Not changing live exit behaviour, triggers or thresholds. Not touching `sentinel_verdicts` (the live
  trigger watcher arms from those rows; a paper row there could reach the executor).
- Not a new stop for paper (that is `SIGNAL_PAPER_LEARN=off`, unchanged).

## Constraints

- The sentinel cycle is proven order-free by an import-graph test (`sentinel-cycle.service.spec.ts`).
  The paper sentinel must carry the same guarantee: its module graph may not reach
  `sentinel-exit-executor`, `trigger-watch`, trade-execution or broker adapters. Enforced by a test.
- Quotes over the owner's own Angel session only; respect the shared 10 req/s budget (piggyback on the
  paper watch's existing 30 s LTP read — no extra quote per rule).
- Judge cost: same judge gate as live (≤ 1 look / position / `SENTINEL_MIN_JUDGE_INTERVAL_SEC`, early on
  tripwires); transport per `SENTINEL_JUDGE` (cli = owner's subscription — these are his own trades).
  Own cap `PAPER_SENTINEL_MAX` (default 5). Off switch `PAPER_EXIT_SHADOW=off` (all) and
  `PAPER_SENTINEL=off` (AI only).

## Design

### Storage — `paper_exit_shadows` (new table)

One row per (paper trade, rule): `trade_id`, `decision_id`, `rule` (`STOP` | `FLOOR` | `GIVEBACK` |
`AI_EXIT` | `AI_TRIGGER`, plus `TRACK` for the running state), `would_exit_at`, `price`, `reason`, `detail jsonb`, `held_pnl` / `rule_pnl` / `saved`
(filled at close), unique (trade_id, rule). AI looks: `paper_sentinel_looks` (trade_id, at, verdict,
reasons, packet digest, model, trigger) — every look, so HOLD quality can be graded too.

### Stage 1 — mechanical rules (in `SignalPaperWatchService`)

On each 30 s sweep, for each open paper trade with its fresh LTP (already fetched), track peak/trough
in memory (restart-safe: re-derive peak from `detail` / mark-to-market) and evaluate, first-hit only:

- **STOP** — LTP crosses the plan's reference stop (`plan.sl`, channel or engine), same side rules as
  `slExitTrigger`; plus the live 240-min trigger expiry noted in `detail` (`expiredBeforeHit`).
- **FLOOR** — `noiseAwareFloor` (exit-discipline/floor.ts) breakeven-then-trail; needs a noise unit —
  from the hub tick source if available, else the plan's ATR/premium proxy, stated in `detail`.
- **GIVEBACK** — exit-discipline giveback helper off the peak.

Pure evaluator `shadowExits(state, ltp, now)` in signal-trader/domain; no I/O.

### Stage 2 — paper sentinel (new `PaperSentinelService`, trade-sentinel module)

- Roster: open paper trades → `RosterEntry` (`trackerId = paper:<tradeId>`, F&O + EQ allowed? —
  same F&O-only remit as live; EQ paper skipped and stated).
- Packet: `ContextPacketService.build(entry, tick, thesis)` with a paper `TickSnapshot` (entry, LTP,
  qty, side, noise) and a thesis built from the decision (invalidation = plan.sl, target = T1).
  Prior verdicts: `build` reads `verdicts.recentForTracker`; for `paper:` ids it must read
  `paper_sentinel_looks` instead (small seam in the packet service).
- Judge: `SentinelAgentService.judge(packet, trigger)`, gated by the existing judge gate.
- Result: every look → `paper_sentinel_looks`; first EXIT_NOW that passes `evaluateExitGate` →
  `paper_exit_shadows` rule `AI_EXIT`. Nothing else.

### Stage 3 — scoring and display

- At paper close (watch service), fill `held_pnl` (the actual paper result), `rule_pnl` (exit price −
  entry × qty × side, same charges model), `saved = rule_pnl − held_pnl`.
- Self-review: new kind `PAPER_EXIT` — per rule: n, % where exiting beat holding, mean ₹ saved; AI
  HOLD looks graded like LIVE_EXIT (price 60 min later). Diagnosis prompt gets the kind.
- Display: one line in the paper trade's exit notes and on the Signals card, e.g.
  `stop 10:42 −₹1.2k · trail 11:05 +₹300 · AI 10:50 +₹150 · held +₹800`.

## Decisions from the builder check (my calls, owner may override)

1. **Scope:** every open signal-trader paper trade. `held` = the paper trade's actual result, and each row
   records its baseline (`learn` = no stop, else stop-or-T1). STOP is not shadowed on a trade that
   already carries a real stop (it would copy the real exit). Self-review splits by baseline. When
   learning mode ends, FLOOR / GIVEBACK / AI still record on stopped trades.
2. **AI exit = the full live `decideExit`** (confirmation, opening guard, persistence), not the gate
   alone: that is "the way live trades are handled". Hard-risk session-close / max-loss clauses are
   excluded — the square-off is the held baseline, not an AI decision.
3. **Extra reads for the AI packet are allowed** (underlying spot, levels, OI walls, news), through the
   same tick source / packet services as live, bounded by `PAPER_SENTINEL_MAX` and the judge gate.
4. **AI trigger is shadowed too:** a HOLD verdict's `exitTrigger` (premium or underlying) is simulated
   against the 30 s LTP as rule `AI_TRIGGER`, with the same tighten-only rule.
5. **Report and propose, never inject:** `PAPER_EXIT` joins the self-review report and may raise tuning
   *proposals* (which stay owner-approved); it does **not** produce lessons injected into the live
   sentinel.
6. **No feed slots:** the paper sentinel wakes from the 30 s sweep only (judge-gate rate cap + bypasses
   computed from that LTP: adverse move, floor breach, trigger cross). No hub tick streams or sensors.
7. **Over the cap:** oldest open paper trades first; the rest are marked `unwatched` in their TRACK row so
   AI statistics never claim to cover them.

The paper sentinel cannot import the signal-trader repository (module cycle): the paper watch pushes each
trade's LTP and plan into it.

## Left to the builder

Exact noise-unit source for FLOOR on options; packet seam shape for prior verdicts; whether
`paper_sentinel_looks` stores the full packet or a digest (size); UI placement details.

## Rollout

Stage 1 → deploy (after 15:35) → verify rows on next session. Stage 2 behind `PAPER_SENTINEL`
(default on per owner) → verify looks, cost, no live-slot impact. Stage 3 with the first closed trades.
