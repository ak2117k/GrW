# Self-review wrong-decision loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every night, grade every trade decision in real ₹, catch silent system failures, find the cause of repeated wrong decisions, and fix them. Settings are changed automatically with rollback, AI reasoning gets lessons, and code bugs become fix tickets queued for the next dev session.

**Architecture:** Three streams on one shared tree.
- **F** builds the decision ledger, the graders and the system detectors into a `decision_grades` table.
- **G1** extends the existing diagnosis into the investigator, writes fix tickets, and shows results in the night report, the self-review page and the dev fix queue.
- **G2** turns allow-listed proposals into automatic, step-limited changes, watches them, rolls them back when needed, and wires the new tunables.

G1 and G2 read F only through the interfaces below.

**Tech Stack:** NestJS + TypeScript (apps/api), Prisma/Postgres, jest (`--no-cache`), React (apps/web, vitest), the existing self-review LLM transport (`SELF_REVIEW_LLM`).

**Spec:** `docs/superpowers/specs/2026-11-04-self-review-wrong-decision-loop-design.md` (goals 1–7, settled decisions S1–S8).

## Global Constraints

- Signal trading is LIVE with real money. Every new behaviour is behind a flag with an off value: `SELF_REVIEW_DECISION_LOOP=on|off` (F and G1, default on), `SELF_REVIEW_AUTO_APPLY=on|off` (G2, default on). The rollback goes in the config comment.
- Use real ₹ everywhere (`contractValueFactor` from `@td/shared`), net of charges (`apps/api/src/modules/trade-sentinel/charges.ts` `estimateCharges`), per 1 lot.
- WRONG = the alternative beat the chosen action by **≥ ₹500 per lot net, or ≥ 1 contract noise unit**.
- `isForbiddenTarget` stays absolute. Never add a tunable for max daily loss, position size, the kill switch, the hold list, the daily exit cap, per-trade or per-underlying loss limits, lots, or trades per day.
- Never push. Never `git stash`, `git reset`, `git checkout` or `git rebase`. Commit only your own files with explicit pathspecs. End messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Write commit messages via a file and Bash, so PowerShell doesn't add a BOM.
- Disk: about 400 MB free. Check `(Get-PSDrive C).Free` in a **separate command before** each jest or tsc run, and stop and report if it is under 250 MB. Run only targeted jest with `--no-cache`.
- `prisma/schema.prisma` is shared by F and G1. Edit it with the Edit tool, adding your own model block only. Migrations go in `prisma/migrations/20261105<hhmm>_<stream>_<name>/` in the existing SQL style. Don't run migrations against any DB.
- The apps/api tsc baseline is 178. Add no errors on lines you change.
- Bump a prompt's version whenever its text changes.
- Follow the self-review idioms: pure `domain/` functions, thin services, fail-soft (a run never throws), dated why-comments.

## Review Focus

1. **A night with no decisions graded** (weekend, holiday, feed down). Expected: the report says "0 decisions graded" plus the reason, and a weekday with 0 graded raises a `SELF_REVIEW_NOTHING_GRADED` ops alert. Owned by G1, test `nothing graded on a trading day alerts`.
2. **A decision whose price path is missing** (no bars). Expected: UNSCORABLE with a reason. It never counts as RIGHT and never feeds a setting change. Owned by F, test `missing bars ⇒ UNSCORABLE, not RIGHT`.
3. **The same bug found on many nights.** Expected: one ticket whose `occurrences` and `lastSeen` grow, never duplicates. Owned by G1, test `same ticket key upserts`.
4. **An auto-applied setting whose affected decision doesn't occur for days.** Expected: the rollback check waits for 3 sessions that contain the decision, and no rollback is driven by empty sessions. Owned by G2, test `sessions without the decision don't count`.
5. **A GOLD decision.** Expected: the ₹ delta uses the ×100 factor. Owned by F, test `GOLD delta uses contract value`.

---

## Stream F — decision ledger, grading, system detectors

Owns: `apps/api/src/modules/self-review/decisions/*` (new), the `DecisionGrade` Prisma model and its migration.

**Interfaces (produced, used by G1 and G2):**
- `DecisionGradeRow` (the table `decision_grades`) has these fields:
  - `id`
  - `sessionDate` (IST `YYYY-MM-DD`)
  - `decisionType`: `'ENTRY_TAKE'|'ENTRY_SKIP'|'ENTRY_BLOCKED'|'SIZE'|'EXIT'|'HOLD'|'GATED_EXIT'|'FLOOR'|'SPIKE_BANK'|'HARD_LOSS'|'LADDER'|'CARRY'|'CARRY_EXIT'|'THESIS'|'DETECTOR'`
  - `detector`: `null | 'LIVE_NOT_PLACED'|'INPUT_MISSING'|'EVENT_NO_ACTION'|'THESIS_CONTRADICTS_DATA'`
  - `refTable`, `refId`, `userId`, `symbol`, `underlying`
  - `mode`: `'live'|'paper'`
  - `decidedAt`
  - `chosen`, `alternative` (short words)
  - `pnlChosen`, `pnlAlternative`, `deltaRupees` (each `number|null`, ₹ per lot net; delta = alternative − chosen)
  - `horizon`: `'15m'|'30m'|'60m'|'close'|'next1h'`
  - `verdict`: `'RIGHT'|'WRONG'|'UNSCORABLE'`
  - `reason` (one line)
  - `facts` (Json)
  - `createdAt`
  - Unique on (`refTable`, `refId`, `decisionType`, `horizon`).
- `DecisionGradingService.gradeSession(sessionDate: string, now?: Date): Promise<{ graded: number; wrong: number; unscorable: number; byType: Record<string, number> }>`. It never throws (fail-soft returns zeros plus an `error` field).
- `DecisionGradeRepository`:
  - `wrongSince(fromSessionDate: string): Promise<DecisionGradeRow[]>`
  - `perDecisionPnl(types: string[], sessionDates: string[]): Promise<{ sessions: string[]; decisions: number; perDecision: number | null }>`, where `sessions` lists only those sessions that had ≥ 1 decision of these types.

### Task F1: Pure graders

- [ ] Create `decisions/grade.ts`:
  - `isWrong(deltaRupees: number|null, noiseUnitRupees: number|null): boolean` (≥ 500 or ≥ 1 unit)
  - `gradeExit({ side, exitPrice, qty, lotQty, valueFactor, segment, path: Bar[] })`
  - `gradeSkip(...)` / `gradeTake(...)` (target/stop first-touch, reusing `signal-trader/domain/fair-score.ts` where it fits)
  - `gradeCarry(...)`
  - `gradeGated(...)` (the gated exit's price vs the eventual exit)

  Each returns `{ pnlChosen, pnlAlternative, deltaRupees, verdict, reason }` per horizon.
- [ ] Tests:
  - `missing bars ⇒ UNSCORABLE, not RIGHT`
  - `GOLD delta uses contract value` (GOLD CE exit 566.5 → path max 865 at 60m, lot 1 ⇒ delta 29850 minus charges, WRONG)
  - `NIFTY exit in noise then +40 pts within 30m ⇒ WRONG`
  - `delta 499 ⇒ RIGHT`
  - `LAURUSLABS 2520CE exit 20.15, path min 16.25 within 60m ⇒ RIGHT`
- [ ] Commit.

### Task F2: The ledger readers and grading service

- [ ] Read each source table for a session:
  - `signal_decisions`: TAKE / SKIP / blocked (`judge.liveGateBlocked`, gate failures) and size
  - `sentinel_verdicts` + `ai_exit_executions`: EXIT, HOLD, GATED_EXIT (status SKIPPED with AWAITING_CONFIRMATION or GATED), and the floor / spike / hard-loss / ladder justification from `gate`
  - `trades` (paper) and `trade_trackers` (real)
  - `intraday_carry_decisions`
  - `sentinel_theses` (THESIS)

  Get bars from `candles_1m`, with broker history only through the existing historical gate. Reuse `ai_exit_outcomes`, `ai_check.fair` and carry scores where present instead of recomputing.
- [ ] Add the `DecisionGrade` model and migration, then the repository with the interface methods above.
- [ ] Tests on a fixture session:
  - `the 2026-11-04 GOLD SKIP grades WRONG with delta > 0`
  - `upsert is idempotent on rerun`
- [ ] Commit.

### Task F3: System detectors

- [ ] Add `decisions/detectors.ts`. Pure functions over pre-read rows, each emitting `DETECTOR` rows:
  - `LIVE_NOT_PLACED`: a signal decision in live mode that passed the gate, with no broker order (`signal_orders` / no `isPaperTrade=false` trade). Group by blocker.
  - `INPUT_MISSING`: a judge, entry-engine or sentinel packet block absent / `NO_DATA`, per underlying, with a count.
  - `EVENT_NO_ACTION`: `eventContextFor` showed `expectMove` on an affected underlying and there were 0 takes on it, while a channel call existed or the underlying moved ≥ 2× its daily ATR.
  - `THESIS_CONTRADICTS_DATA`: an INFERRED thesis whose invalidation was already breached by the stored underlying bar at entry, or whose claimed breakout level wasn't above (LONG) the entry underlying.
- [ ] Tests:
  - `11-04 shape: 12 risk_manager blocks ⇒ one LIVE_NOT_PLACED row with count 12`
  - `LAURUSLABS 2600CE thesis 2343.9 vs 2310 ⇒ THESIS_CONTRADICTS_DATA`
  - `GOLD on US_MIDTERM_RESULTS with 0 takes and a channel call ⇒ EVENT_NO_ACTION`
- [ ] Commit.

---

## Stream G1 — investigator, fix tickets, reporting

Owns:
- `self-review/diagnose/*`
- `self-review/lessons/types.ts` (scopes only)
- `self-review/tickets/*` (new)
- `self-review/services/self-review-run.service.ts`
- `self-review/controllers/self-review.controller.ts`
- the night-report "Wrong decisions" section (night-report module)
- the web self-review page
- `scripts/ops/pull-fix-queue.sh` (new)
- the `FixTicket` model and its migration

**Interfaces:**
- Consumes `DecisionGradingService.gradeSession` and `DecisionGradeRepository.wrongSince` (F). If F hasn't landed yet when you need it, code against these signatures with a local fake in tests.
- Produces `FixTicket` (`fix_tickets`):
  - `id`
  - `key` (unique, a stable slug of cause plus component)
  - `cause`: `'CODE_BUG'|'DATA'`
  - `title`, `evidence` (Json), `proposedChange`
  - `files` (string[])
  - `testDescription`
  - `status`: `'OPEN'|'DONE'|'WONTFIX'`
  - `occurrences`, `costRupees`, `firstSeen`, `lastSeen`

  Endpoint: `GET /api/self-review/fix-queue?format=md`.

### Task G1a: The run calls grading, and the diagnosis gains a `cause`

- [ ] In `self-review-run.service.ts`, run `gradeSession(today)` before the diagnosis. Add WRONG and DETECTOR rows from the last 10 sessions into the misses the diagnosis receives, as `MissInput` with `kind: 'DECISION:<type>'`, capped as today.
- [ ] Diagnosis schema and prompt:
  - each group gets `cause: 'DATA'|'SETTING'|'REASONING'|'CODE_BUG'|'NOISE'` and an optional `ticket: { title, proposedChange, files, testDescription }`
  - `LESSON_SCOPES` gains `thesis` and `news`
  - bump `DIAGNOSIS_PROMPT_VERSION`
- [ ] Pattern gate in pure `diagnose/actionable.ts`: `actionable(group: { occurrences: number; sessions: number; maxCostRupees: number }): boolean`, true when ≥ 3 occurrences in ≤ 10 sessions or `maxCostRupees ≥ 5000`. NOISE is never actionable. Only actionable groups produce lessons or tickets; SETTING groups still go to the existing proposal engine (S1).
- [ ] Tests:
  - `cause parsed and validated; unknown cause ⇒ dropped with reason`
  - `NOISE never actionable`
  - `2 occurrences / ₹800 ⇒ not actionable`
  - `1 occurrence ₹5,200 ⇒ actionable`
- [ ] Commit.

### Task G1b: Fix tickets, the queue endpoint and the dev pull script

- [ ] Add the `FixTicket` model and migration. The repository upserts by `key`, increments `occurrences` and updates `lastSeen` and `costRupees`. Cover it with the test `same ticket key upserts`.
- [ ] Add the endpoint returning markdown, ordered by OPEN, then cost, then lastSeen.
- [ ] Add `scripts/ops/pull-fix-queue.sh`. It uses SSH with `-i ~/.ssh/grw_oracle -o BatchMode=yes root@157.10.98.70` and runs a read-only psql (`PGOPTIONS='-c default_transaction_read_only=on'`) that selects OPEN tickets and writes `docs/self-review/fix-queue.md`. If SSH fails it writes one line, "fix queue unavailable: <reason>". Add `docs/self-review/fix-queue.md` to `.gitignore`. The SessionStart hook is the coordinator's job.
- [ ] Commit.

### Task G1c: "Wrong decisions" in the night report and the self-review page

- [ ] Night report: add a section in plain language. Each item covers:
  - what was decided
  - what would have been better, in ₹
  - the cause
  - the action taken (`applied <target> a→b` / `lesson <key>` / `ticket <title>` / `watching`)

  It always shows "graded N, wrong W, unscorable U". On a weekday with 0 graded it sends `sendOpsAlert` `SELF_REVIEW_NOTHING_GRADED`; cover that with the test `nothing graded on a trading day alerts`.
- [ ] Web self-review page: a "Wrong decisions" list and a "Fix queue" list from the existing self-review API, with a vitest render test.
- [ ] Commit.

---

## Stream G2 — auto-apply, rollback, new tunables

Owns:
- `self-review/tuning/*`
- `self-review/domain/proposals.ts`
- new `self-review/auto-apply/*`
- the consumer edits needed to read the new tunables:
  - `signal-trader/domain/signal-trader.config.ts`, plus where the judge min confidence and default are read
  - `exit-discipline/config.ts` (floor arm/trail, spike bank)
  - `intraday-carry/domain/carry-config.ts` (decide-by)
  - the persist reader

**Interfaces:**
- Consumes `DecisionGradeRepository.perDecisionPnl` (F; fake it in tests until it lands) and the existing proposals, `tuning_overrides` and `TuningReader`.
- Produces `AutoApplyService.run(now: Date): Promise<{ applied: Change[]; rolledBack: Change[]; blocked: string[] }>`, on its own cron `0 30 19 * * 1-5` IST (after the 18:45 self-review).

### Task G2a: New tunables, read at session open

- [ ] Add to the allow-list, with their defaults set to today's env/code values:
  - `signal.judgeMinConfidence` (number 50–80)
  - `signal.judgeDefaultTake` (boolean)
  - `exit.floorArmN` (1.0–3.0)
  - `exit.floorTrailN` (1.0–3.5)
  - `exit.spikeBankRiseN` (1.5–4.0)
  - `exit.spikeBankTrailN` (0.5–2.0)
  - `carry.decideByMin` (4–9)

  Consumers read them through `TuningReader`, taking a snapshot once per session open (IST date change), never mid-session (S7).
- [ ] Tests:
  - `override read at next session open, not mid-session`
  - `unknown/forbidden target ignored`
  - `isForbiddenTarget rejects any name containing maxDailyLoss|lots|tradesPerDay|lossLimit|killSwitch|hold|dailyCap`
- [ ] Commit.

### Task G2b: Auto-apply with step limit, then watch and roll back

- [ ] In pure `auto-apply/policy.ts`:
  - `stepLimit(t: NumberTunable, from: number, to: number): number`, clamping the move to ≤ 25% of (max − min)
  - `mayChange(target, history, sessionsNow): boolean`, allowing at most 1 change per target per 5 sessions and no same-direction change within 20 sessions of a rollback
  - `rollbackDue(before: {perDecision; sessions}, after: {perDecision; sessions}): boolean`, which needs 3 sessions *with* the decision on each side and rolls back when after < before
- [ ] `AutoApplyService`:
  - Pending proposals that passed the existing `evidenceGate` are applied through the existing `approveAndApply`, with `by='auto'`, the value step-limited.
  - The decision types affected per target are a static map, e.g. `exit.floorTrailN → ['EXIT','FLOOR','GATED_EXIT']`.
  - Applied changes are checked by `rollbackDue`. A rollback restores the previous value and records a direction block.
  - Each apply and rollback is announced with `sendOpsAlert` and shown in the night report via a `changes` read for G1. Expose `AutoApplyService.recentChanges(sinceSessionDate): Promise<Change[]>` for G1.
  - `SELF_REVIEW_AUTO_APPLY=off` ⇒ today's behaviour (PENDING waits for the owner).
- [ ] Tests:
  - `step limited to 25% of range`
  - `second change within 5 sessions blocked`
  - `sessions without the decision don't count`
  - `worse after 3 sessions ⇒ rollback + 20-session direction block`
  - `flag off ⇒ nothing applied`
- [ ] Commit.

---

## Integration (coordinator)

- [ ] Add a Claude Code SessionStart hook in the project `.claude/settings.json` (use the update-config skill) that runs `scripts/ops/pull-fix-queue.sh` and prints the top of `docs/self-review/fix-queue.md`.
- [ ] Run targeted jest for the self-review, night-report, signal-trader, exit-discipline and intraday-carry modules and the web self-review test, then tsc (≤ 178). Review the diff.
- [ ] Ask the owner, then push main after 15:35 IST. Verify the 18:45 run and the 19:30 auto-apply logs the next evening.
