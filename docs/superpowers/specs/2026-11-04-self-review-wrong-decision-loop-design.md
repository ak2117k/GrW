# Self-review: the wrong-decision loop — design

Date: 2026-11-04. **(owner)** marks owner decisions, **(call)** marks assistant calls.

## 1. Why

On 4 Nov the owner and the assistant found by hand, in one session, six problems that had each cost real money for days. The nightly self-review (`apps/api/src/modules/self-review`, cron 18:45 IST) caught none of them:

1. The signal judge skipped 65 of 70 channel calls. Its scored skips missed +₹34.6k and avoided −₹9.3k per lot over 21 days.
2. **No live signal order was ever placed** from 2 Nov. The account risk manager counted paper trades against the live position limit.
3. GOLD had no futures bars and no option chain, the entry engine didn't watch it, and entry sizing was 100× wrong.
4. A manual LAURUSLABS option was exited on an invented thesis (an invalidation already breached at entry).
5. NIFTY exits came in noise; a LAURUSLABS 2520 CE gave back a 31.7 peak to exit at 20.15 after 7 gated exit calls.
6. The US-election event day passed with the calendar holding the event and nothing reading it.

Today's self-review only diagnoses `verification_results` rows with `correct=false` for a few kinds (SIGNAL_JUDGE, PAPER_EXIT, ENGINE_ENTRY, noise reads). It writes lessons and proposes allow-listed tunables that the **owner must approve** in the app.

The owner's ask **(owner)**: "it should do the analysis if we are taking any wrong decision during the trade, note it down, find the cause and fix it". It should "update the application accordingly" and "show as it is doing right now". The six items above are *examples* of what it must cover, not the whole list.

## 2. Goals

1. **Decision ledger.** Every decision the system makes on a trade is recorded with the facts it saw and the reason it gave:
   - entry take/skip (judge, gate blocks, risk-manager blocks, entry engine);
   - size;
   - hold / exit verdicts and the exit-gate outcome (PASS / GATED / AWAITING_CONFIRMATION);
   - floor arm / trail / break, spike bank, hard loss;
   - target ladder;
   - the intraday close CARRY / EXIT;
   - the thesis inferred.

   Most of these already exist across tables (signal_decisions, sentinel_verdicts, ai_exit_executions, exit_noise_reads, intraday_carry_decisions, entry_engine_decisions, trades, trade_trackers). The ledger is a *view* over them plus whatever is missing, not a rewrite.
2. **Grading.** Each decision is graded against what happened. The counterfactual is the other choice, in real ₹ (`contractValueFactor`), net of charges, at +15 / +30 / +60 min and at the session close (next morning for carries). A decision is **WRONG** when the alternative was better by ≥ ₹500 per lot or ≥ 1 noise unit of the contract **(call)**. Where `ai_exit_outcomes`, `ai_check` fair scoring or carry scoring already grade a decision, use them; don't duplicate.
3. **System detectors.** Some wrong decisions are absences, not choices. They need detectors that grade the system, not a trade:
   - **Live-eligible but never placed:** a call passes the gate in live mode but no broker order exists, grouped by blocker. Item 2 would have fired on 3 Nov.
   - **An input missing on a decision:** a judge or engine packet with a block `absent` / `NO_DATA`, per underlying. The inputs-health module covers live alerting; this covers its cost.
   - **An event day with no action** on an affected underlying.
   - **A decision's stated facts contradict the data at that time,** for example an inferred thesis claiming a breakout that the stored bars show didn't hold (item 4).
4. **Investigation.** Each night, WRONG decisions (and detector hits) are grouped by likely shared cause. An AI investigator reads, per group:
   - the ledger rows;
   - the market data around them (bars, chain, news);
   - the rule or clause records that fired.

   It names the cause as one of:
   - `DATA`: missing, stale or wrong input;
   - `SETTING`: a tunable threshold is off;
   - `REASONING`: an AI's judgement or prompt is wrong;
   - `CODE_BUG`: the code did something its own comment or spec says it shouldn't;
   - `NOISE`: the market did something no rule could know.

   It cites evidence (row ids, numbers) and a concrete fix. It extends the existing diagnosis service: new categories and inputs, same fail-soft transport.
5. **Patterns before action.** A cause acts only when it repeats. Actions require ≥ 3 occurrences in 10 sessions, or one occurrence costing ≥ ₹5,000 **(call)**. One-offs are recorded and shown, nothing more. NOISE never acts.
6. **Fix, by cause.**
   - **DATA:** an inputs-health alert, plus a refill / retry where the code supports it.
   - **SETTING: applied automatically (owner).** Only allow-listed tunables (`self-review/tuning/tunables.ts`) and within their bounds. New tunables needed for today's examples get added to the allow-list:
     - judge min confidence;
     - judge default take/skip;
     - floor arm/trail N;
     - spike-bank rise/trail;
     - exit persistence seconds;
     - carry decide-by minutes.

     Each auto-change is announced (Telegram + night report) with the evidence. It is **watched**: if the next 3 sessions grade worse on the affected decisions than the 3 before, it is rolled back automatically and the rollback announced. `isForbiddenTarget` stays absolute. Max daily loss, position size, the kill switch, the hold list, the daily exit cap, loss limits per trade and per underlying, lots and trades per day can never be changed by the loop.
   - **REASONING:** a lesson through the existing lessons path (2-session gate, factor grounding), scoped to that AI (judge, sentinel, thesis, news reader).
   - **CODE_BUG:** no automatic code change **(call; owner: "show as it is doing right now")**. A **fix ticket** is written: cause, evidence, the failing behaviour as a test description, and the proposed change with file paths. It is shown in the app's self-review page and the night report, and exported to the repo as `docs/self-review/fix-queue.md` via an API endpoint the assistant reads at the start of a session. The assistant fixes queued tickets first in the next session.
7. **Shown like now.** The night report and the self-review page gain a "Wrong decisions" section in plain language. Each item says:
   - what was decided;
   - what would have been better, in ₹;
   - the cause;
   - what was done about it (applied / lesson / ticket / watching).

   Applied settings and rollbacks are listed separately.

## 3. Non-goals / anti-goals

- No automatic code edits or deploys.
- No changes to hard risk limits (CLAUDE.md §9).
- No new direction models.
- No hindsight lessons from one session (memory: self-review-lesson-noise). The pattern gate in goal 5 and the lessons 2-session gate stay.
- Failure modes:
  - The loop changes a setting on a lucky or unlucky day and keeps it. That is why rollback and the pattern gate exist.
  - The loop goes silent, like today's inert-code failures. The night report must say "0 wrong decisions found" explicitly, with the number of decisions graded. A run that graded nothing is itself an alert.

## 4. Constraints

- Runs as prod crons (memory: night jobs automatic). The investigator uses the existing self-review LLM transport (`SELF_REVIEW_LLM`) and its budget.
- Real ₹ everywhere (`contractValueFactor`); net of charges (trade-sentinel `charges.ts`).
- Every new behaviour sits behind a flag with an off value, e.g. `SELF_REVIEW_AUTO_APPLY=on|off` (default on per the owner) and `SELF_REVIEW_DECISION_LOOP=on|off`.
- Disk on the dev machine is critically low (see the earlier plan's constraints); tests are targeted.

## 4a. Decisions settled after the builder check (all **(call)**; owner said "go ahead")

| # | Decision |
|---|---|
| S1 | **A setting changes only through the existing statistical gate** (`evidenceGate` in `domain/proposals.ts`: ≥ 5 judged cases, ≥ 10 sessions, p < 0.05). Goal 5's "3 in 10 sessions or one ≥ ₹5k" gates *investigation, tickets and lessons*, never a setting change. A one-off big loss can open a ticket or a lesson but can never move a knob. |
| S2 | **Auto-apply covers every allow-listed tunable** (owner: "update the application accordingly"). The deterministic proposal engine picks the value, never the LLM. One change moves at most **25% of the tunable's range** per step, and only one change per target per 5 sessions. Today's owner approve/reject stays available as an override. |
| S3 | **Paper and live evidence count the same.** A decision is graded on the market's price path, not on whether the order was real, and `tuning_overrides` stays one global row per target. |
| S4 | **Rollback:** compare ₹ per affected decision, net, over the next 3 sessions in which the decision actually occurred, against the 3 such sessions before the change. Sessions without one don't count. Worse ⇒ automatic rollback, plus a 20-session block on the same direction, the same way `evidenceCutoff` treats REJECTED. |
| S5 | **Fix queue to the dev session:** prod stores tickets in a table and serves them at an API endpoint. In the repo, `scripts/ops/pull-fix-queue.sh` uses the existing SSH key with a read-only psql query to write `docs/self-review/fix-queue.md`, which is gitignored. A Claude Code SessionStart hook runs it, so the assistant sees the queue at the start of every session. No new credential. |
| S6 | **Built after the two sibling specs** (deployed in cc9cf327). Detectors read today's tables plus the new ones: `intraday_carry_decisions`, `news_impacts.event_risk` and the thesis inference inputs. The thesis-contradiction detector compares the thesis direction, level and invalidation with the stored underlying bars at entry. |
| S7 | **New tunables are read through `TuningReader` and take effect at the next session open,** never mid-session. The consumer refactors in signal-trader, exit-discipline and intraday-carry are accepted. |
| S8 | **The investigator extends the existing diagnosis call** (one LLM call, one budget). Each diagnosed group gains a `cause` field (DATA / SETTING / REASONING / CODE_BUG / NOISE) next to the existing `category`, plus an optional `ticket`. `LESSON_SCOPES` gains `thesis` and `news`. Bump the prompt version. |

## 5. Left to the builder

- The ledger's storage (view vs table).
- Counterfactual details per decision type.
- The grouping method.
- The investigator prompt.
- The new tunables' exact bounds.
- The fix-queue endpoint's shape.
- The report layout.
