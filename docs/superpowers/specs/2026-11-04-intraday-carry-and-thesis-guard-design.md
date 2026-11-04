# Intraday carry decision + thesis guard — design

Date: 2026-11-04 · Owner decisions marked **(owner)**; builder/assistant calls marked **(call)**.

## 1. Why

Two real LAURUSLABS option calls (30 Oct 2520 CE, 4 Nov 2600 CE) were read right by the owner, and the engine
managed both badly:

- **4 Nov 2600 CE** (NRML, bought 15:21 IST @ 5.15 with the stock at ~2310). The thesis service *inferred*
  "breakout above PDH 2343.9, cleared and held" — false at entry (the stock had broken 2343.9 earlier, high 2374.8,
  and faded back to 2310). Its invalidation (2343.9) was already breached the moment the trade opened, so
  `THESIS_INVALIDATION` passed at once and two consecutive EXIT_NOW verdicts sold it at 15:24 (−₹51, charges).
  The AI also argued "8 minutes to close, no time to recover" for a carry-forward option with 19 days left; the
  `square-off-due` wake fires for F&O on SESSION_CLOSE regardless of product type
  (`trade-sentinel/services/square-off-look.ts`).
- **30 Oct 2520 CE** ran to 31.7 on 2 Nov; the exit came 10 minutes after the first EXIT_NOW (7 × AWAITING_CONFIRMATION)
  at 20.15. (Spike bank, deployed 3c853c6, targets this; not in scope here beyond a replay check.)

Root cause the inference request never sees the **underlying price at entry** — only the option premium and the
level book (`thesis.service.ts` `InferenceRequest`) — so it narrates a setup from the day's structure, not from
where the trade actually was.

The owner's goal **(owner)**: the engine works out every factor itself and makes the decision, with a recorded
reason. No manual input or manual verification by the user — "there will be no meaning of this if we have to do the
manual verification".

## 2. Goals

1. **Intraday positions: the engine decides at the close** whether to convert to carry-forward (overnight) or exit,
   and records why. **(owner)**
2. **Carry-forward positions: left as they are.** The user chose overnight at entry; the close is never a reason
   to exit, and the close argument is not offered to the AI. **(owner)**
3. **A guessed (INFERRED) thesis can never exit a trade on its own,** and a guess that was already wrong at entry is
   discarded.
4. **For manual trades, the AI's own exits are limited to the hard rules:** loss limit (MAX_LOSS / noise-aware cap),
   profit floor (all FLOOR_HARD_* rules incl. green lock), spike bank. **(owner, agreed in chat)**
5. **Every carry/exit-at-close decision is scored automatically** the next session, so its quality is visible
   without the user checking trades.
6. **Stock options are judged with the underlying stock's live bars**, not blind.

## 3. Non-goals / anti-goals

- No new direction/noise predictor. Every direction test so far is a coin flip (see research/ and memory); the
  carry decision is the AI judge's call plus facts, not a new model.
- No new manual step for the user (no "why I'm in" form required). The existing thesis-correction path stays as an
  optional override but nothing depends on it.
- Must not touch carry-forward entries' day-time protections (loss limit, floor, spike bank stay on).
- Failure if: a position is left to the broker's MIS square-off because the decision or the conversion silently
  didn't happen (the silent-absence pattern); or a conversion is assumed done when the broker didn't do it.

## 4. Decisions already made

| # | Decision | By |
|---|---|---|
| D1 | Applies only to positions whose product is INTRADAY (MIS). CARRYFORWARD / NRML (and DELIVERY) are never converted, never exited because of the close. | owner |
| D2 | The AI judge picks CARRY or EXIT and writes the reason; no fixed rule list from the owner. | owner |
| D3 | **Live from day one** on real positions — explicit owner exception to the CLAUDE.md "new strategies start in paper" rule (2026-11-04). Still ship behind an env flag so it can be rolled back. | owner |
| D4 | If the conversion fails or can't be verified before the broker's square-off deadline, the engine exits at market instead. | call |
| D5 | Whole position only: CARRY or EXIT, no partial (signal trades are 1 lot). | call |
| D6 | Expiry day: a contract expiring today is never carried; the existing expiry window keeps working for both products. | call |
| D7 | AI_AUTO_EXIT_HOLD (owner hands-off) positions: no conversion and no exit — the hold wins; log that the broker will square it off if it's MIS. | call |
| D8 | "Manual trade" = a position whose thesis source is INFERRED (opened outside the platform). Platform-opened trades (signal-trader, entry engine) keep their recorded thesis (written as source USER) and current exit rules. | call |
| D9 | The close-time CARRY/EXIT decision applies to manual intraday trades too (goal 1 covers every intraday position). An EXIT at the close is justified by the existing `HARD_SESSION_CLOSE` clause, which stays; goal 4 limits only the AI's *mid-session* exits on manual trades. | call |
| D10 | On manual trades, only `THESIS_INVALIDATION` / `THESIS_LEVEL` lose their power to pass. Everything else stays: HARD_MAX_LOSS, HARD_SESSION_CLOSE, HARD_EXPIRY, HARD_DAILY_LOSS, every FLOOR_* clause (soft and hard), spike bank, TARGET_LADDER (owner approved it for manual trades 2026-11-03). | call |
| D11 | `AI_AUTO_EXIT_DAILY_CAP` used up at the close: a CARRY still runs (a conversion is not an exit). An EXIT that the cap blocks is logged as `CAP_BLOCKED_BROKER_SQUARE_OFF`, and the broker square-off is accepted. The cap is not bypassed, because the safety exemption isn't approved. | call |
| D12 | Paper intraday positions get the same CARRY/EXIT decision, simulated (no broker call), so scoring builds up faster. Real conversion happens only on live positions. | call |
| D13 | Live conversion runs only for the owner's account (a per-user allow-list env, e.g. `INTRADAY_CARRY_USERS`). Other tenants haven't agreed to the live-from-day-one exception. | call |
| D15 | Channel (signal-trader) intraday trades are in scope too: the engine may carry them overnight. The overnight gap risk past the ₹2k loss limit is accepted. | owner |
| D14 | If the underlying price at entry is unknown (late inference, no bars yet), the inferred invalidation is kept *record-only* and the judge is told the entry context is unknown. | call |

## 5. What to build

### 5.1 Carry-forward: stop treating the close as a deadline
- `square-off-look.ts` / `judge-gate.ts`: no `square-off-due` fire and no `squareOffDecision` framing for an F&O
  position whose product is CARRYFORWARD on a non-expiry day. The product type is already in gate facts
  (`facts.productType`); the builder finds where the roster/tick carries it (Angel position book `producttype`).
- System/packet prompt: for carry-forward non-expiry positions, state "held overnight by the user's choice; the
  session close is not a reason to exit". Bump the prompt version and golden snapshots.

### 5.2 Thesis guard
- Inference request gains the **underlying price at entry** (and the day's high/low so far, VWAP) so the model sees
  where the trade actually was.
- After inference, a pure check: for LONG, `invalidation >= underlyingAtEntry` (SHORT mirrored) ⇒ the invalidation
  (and the level, if it's the same claim) is set to null with a recorded reason
  ("invalidation already breached at entry, discarded").
- Exit gate (`exit-discipline/gate.ts`): when the thesis source is INFERRED, `THESIS_INVALIDATION` /
  `THESIS_LEVEL` can't by themselves produce a PASS; they are reported (record-only). Exits on manual trades
  come only from the hard rules in goal 4. USER-sourced and platform theses are unchanged.

### 5.3 Intraday close decision (CARRY / EXIT)
- In the intraday hard-risk window (existing: MIS cash 15:15 lead; F&O close guard 10 min — builder confirms the
  real Angel MIS square-off times for NFO/BFO/MCX and opens the window early enough to convert and verify), the
  judge is asked a new forced question: CARRY or EXIT, with reason. The packet carries the facts it needs: net P&L,
  floor state, days to expiry and theta, underlying vs entry / VWAP / levels, next-session events (results calendar
  already used by the stock model), required carry margin vs available funds.
- CARRY ⇒ Angel `convertPosition` (MIS → NRML/CARRYFORWARD). The SDK exposes it
  (`smartapi-javascript` `convertPosition`), our broker adapter doesn't yet — add it to the adapter interface and
  the per-user broker session. **The SDK never rejects** (memory: errors resolve to `{}`/`{status}`), so success is
  only what the position book shows after the call. Retry once; if not verified by the deadline minus a safety
  margin ⇒ EXIT at market (D4).
- Carried position: the tracker records the new product type; from the next session it is a normal carry-forward
  position (5.1 applies).
- Every decision persists a row (decision, reason, facts, conversion result, broker response) — new table or an
  extension of `ai_exit_executions`; builder's choice.
- Env flag, e.g. `INTRADAY_CARRY=live|off` (default live per D3). Off = today's behaviour.

### 5.4 Scoring
- Next-session job (prod cron, not manual — memory: night jobs are automatic) scores each decision:
  for CARRY — overnight gap, the next session's first-hour max/min and close-of-first-hour P&L vs exiting at the
  decision price; for EXIT — the same counterfactual had it been carried. Same shape as `ai_exit_outcomes`
  (missed/saved). Feed it into the nightly self-review.

### 5.5 Underlying bars for stock options
- While a stock-option position is open, keep the underlying stock (NSE cash token) on the market hub's pinned
  lines so 1m bars exist. Feed slots are scarce (30) — one slot per distinct open underlying, released on close.

## 6. Constraints

- Hard limits still apply and AI can't override them (CLAUDE.md §9). Overnight the loss limit can't act until the
  next open; gap risk is accepted by the owner (told in chat).
- Respect `AI_AUTO_EXIT_DAILY_CAP` (15) — close-time exits count toward it today; the proposed safety-exit
  exemption is NOT approved, so don't add it.
- Credentials via CredentialDecryptor only; never log broker payloads with secrets.
- Rate limit Angel ≤ 10 req/s.
- Commit with explicit pathspecs; never push non-main branches (Cloudflare deploys every branch).
- Deploy after 15:35 IST unless the owner says otherwise.

## 7. Left to the builder

- Exact window timing per exchange, retry cadence for conversion verification.
- Storage shape for decisions and scores.
- Prompt wording (with golden snapshots).
- Hub pinning mechanism for underlying stocks.
- A replay of the 2 Nov LAURUSLABS 2520 CE trade under the current spike bank (report only).
