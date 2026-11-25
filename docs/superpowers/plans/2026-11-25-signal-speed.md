# Signal Speed Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Cut the time from a Telegram trade call being posted to our order attempt from ~60 s to ~20 s, and stop losing approved calls to a one-shot price re-check.

**Architecture:** Four independent changes on the live signal path (`signal-trader`, `telegram-reader`): per-step timings on every decision, a deadline on the judge's market-data collection, re-arming a trigger entry that slips back before the order, and faster Telegram polling with flood-wait backoff.

**Tech Stack:** NestJS 10, Prisma, Jest.

**Spec (short design, owner-approved 2026-11-25 "yes go ahead with all four"):**
- Evidence (prod 2026-11-25): HEROMOTOCO 5800 CE and COPPER 1000 PE were judged TAKE and then skipped `price_moved`. Post → order attempt was ~68 s and ~56 s: Telegram receive 2–20 s (poll every 20 s; live push delivers 0 for this session), market-data collection + checks ~40–50 s (untimed), AI judge 11–15 s. HEROMOTOCO's trigger fired at 10:52:36 (LTP 141 ≥ 140), the pre-send quote 18 s later was 138.75 → skipped for good because `retryEntry` returns null for any plan that already has a trigger (`signal-trader.service.ts:806`); price then sat 140–145 from 10:59 to 11:09.
- Owner's requirement: "after getting a signal we have to use it as soon as possible so that we don't miss any move."
- Decided: (1) record per-step timings; (2) cap the judge's context build with a deadline; (3) a trigger entry that slips back before sending re-arms until its own expiry instead of skipping; (4) poll Telegram faster with backoff on FLOOD_WAIT.
- Trade-off accepted for speed: a context block that misses the deadline reaches the judge as `unavailable` with its reason (the judge already handles unavailable blocks).
- Non-goals: no change to risk limits, bands, SL rules, caps, the judge prompt or model; COPPER's don't-chase band is unchanged.

## Global Constraints

- Live trading path: every change must keep current behaviour when its new setting is absent, except where this plan states the new default.
- New env: `SIGNAL_CONTEXT_DEADLINE_MS` default 6000 (range 1000–30000); `TELEGRAM_POLL_SEC` default changes 20 → 6, minimum clamp 15 → 5.
- Never decide or measure anything on 1m bars.
- Run API tests as `cd apps/api && npx jest <pattern>`; tsc `cd apps/api && npx tsc --noEmit -p tsconfig.json` (~178 pre-existing errors; judge only touched files).
- Commit with explicit pathspecs; message ends `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push. Deploy only after 15:35 IST.

## Review Focus

1. A trigger entry re-armed after a slip must never fire after its original `expiresAt`, never re-arm when the SL is crossed, and never place two orders for one decision.
2. A context block that times out must still leave every other block present (per-block, not whole-packet).
3. Telegram FLOOD_WAIT must slow the poller, not hammer it; after the wait the interval returns to normal.
4. Timings must never throw or delay the decision; missing steps are recorded as null.
5. With `SIGNAL_CONTEXT_DEADLINE_MS` unset the default 6000 applies (stated new default) — the judge packet keys are unchanged.

---

### Task 1: Per-step timings on every decision

**Files:** Modify `apps/api/src/modules/signal-trader/services/signal-trader.service.ts`; Test: a new `signal-trader.timings.spec.ts` (or the existing service spec).

**Interfaces — Produces:** `judge.timings` on the stored decision (`signal_decisions.judge` JSON, no schema change): `{ receivedToStartMs: number|null, contextMs: number|null, contextBlocks: Record<string, { status: 'present'|'unavailable'; ms: number }> | null, noiseMs: number|null, lateRoomMs: number|null, modelMs: number|null, oiCheckMs: number|null, delayedCheckMs: number|null, preSendQuoteMs: number|null, totalToSendMs: number|null }`. `receivedToStartMs` = decision start − the Telegram message's `receivedAt` when known. Persist on every exit that writes the judge (TAKE, PAPER, SKIP, PENDING arm).

- [ ] Step 1: failing tests — `records model, context and pre-send timings on a live TAKE`; `records timings on a price_moved SKIP`; `a timing helper that throws never changes the decision`.
- [ ] Step 2: run, expect FAIL.
- [ ] Step 3: implement with a small `Stopwatch` helper (monotonic `performance.now()`), no behaviour change.
- [ ] Step 4: run signal-trader tests, expect PASS.
- [ ] Step 5: commit `feat(signal-trader): per-step timings on every signal decision`.

### Task 2: Deadline on the judge's market-data collection

**Files:** Modify `signal-trader/services/signal-trader.service.ts` (`runJudge`), `signal-trader/domain/signal-trader.config.ts`; Test: service/config specs.

**Interfaces — Consumes:** `SignalContextService.build({..., deadlineMs?})` (already on this branch, commit 1a6a5011: each block's timeout = min(own, deadlineMs)). **Produces:** config `contextDeadlineMs` from `SIGNAL_CONTEXT_DEADLINE_MS` (default 6000, valid 1000–30000, invalid → default with a config problem logged like the other `num()` settings). `runJudge` passes `deadlineMs: cfg.contextDeadlineMs`; the `context.noise(...)` and `lateRoomFor(...)` calls are each raced against the same deadline and on timeout become `{ status: 'unavailable', reason: 'timed out after <n> ms' }` (noise) / `null` room with a reason (late room) — same shapes the code already produces on error.

- [ ] Step 1: failing tests — `passes the configured deadline to the context build`; `a hanging structure block leaves chain and market present` (service level, fake context); `noise that hangs is unavailable after the deadline`; config: `default 6000`, `out of range falls back`.
- [ ] Step 2: run, expect FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run signal-trader tests, expect PASS (existing judge packet tests unchanged).
- [ ] Step 5: commit `perf(signal-trader): cap the judge's market-data collection at SIGNAL_CONTEXT_DEADLINE_MS`.

### Task 3: Re-arm a trigger entry that slips back before sending

**Files:** Modify `signal-trader/services/signal-trader.service.ts` (`retryEntry` ~line 794–833 and the trigger-fire path); Test: the existing trigger/retry spec for signal-trader.

**Behaviour:** when the pre-send re-check fails for price (`kind: 'price'`) on a plan that already has a trigger, and the SL is still on the protective side, and `now < trigger.expiresAt`: put the decision back to waiting on the SAME trigger (same price/op/band, same `expiresAt`, `retry` set with the detail), persist via the existing `repo.touchTrigger`/`armTrigger` path, keep it in `this.pending`, return `{ decision: 'PENDING' }`. When the SL is crossed or the trigger has expired → skip `price_moved` as today. Funds retries on a trigger plan: unchanged. One decision can place at most one order.

- [ ] Step 1: failing tests — `a fired trigger whose pre-send quote slipped below the band re-arms until its expiry` (HEROMOTOCO case: trigger ABOVE 140, band [140,144.2], fresh 138.75, SL 136.6 → PENDING, same expiresAt); `re-armed trigger fires again when price returns and places one order`; `SL crossed at pre-send → SKIP, no re-arm`; `pre-send slip after expiresAt → SKIP price_moved`.
- [ ] Step 2: run, expect FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run signal-trader tests, expect PASS.
- [ ] Step 5: commit `fix(signal-trader): a trigger entry that slips back before sending waits until its expiry instead of skipping`.

### Task 4: Faster Telegram polling with flood-wait backoff

**Files:** Modify `apps/api/src/modules/telegram-reader/services/telegram-listener.service.ts`; Test: `telegram-reader/__tests__/telegram-listener.service.spec.ts`.

**Behaviour:** `DEFAULT_POLL_SEC` 20 → 6; clamp `Math.max(15, sec)` → `Math.max(5, sec)`. On FLOOD_WAIT (existing `floodWaitSeconds(err)`): skip the rest of the round (as today) AND pause polling until `now + wait s`; then double the interval for 10 min (cap 30 s), then return to the configured interval. Log one warning per backoff with the wait. The media backfill cadence stays ~every 5 min (derive the tick modulus from the interval instead of the hard-coded 15).

- [ ] Step 1: failing tests — `polls every 6 s by default`; `TELEGRAM_POLL_SEC=3 is clamped to 5`; `FLOOD_WAIT 12 pauses polling 12 s then runs at double interval for 10 min`; `media backfill still runs about every 5 min at 6 s`.
- [ ] Step 2: run, expect FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run telegram-reader tests, expect PASS.
- [ ] Step 5: commit `perf(telegram-reader): poll every 6 s with flood-wait backoff`.

### Task 5: Release

- [ ] Run `cd apps/api && npx jest src/modules/signal-trader src/modules/telegram-reader` — all pass.
- [ ] After 15:35 IST with no open-position decision pending and owner OK: merge to `main`, push, verify containers run the new SHA.
- [ ] Next session: read `judge.timings` on the first calls; report post → order time vs ~60 s before.
