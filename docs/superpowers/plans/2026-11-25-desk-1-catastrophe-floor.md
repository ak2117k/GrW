# Desk Plan 1 — Catastrophe Floor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat ₹2,000 per-trade loss exit with an instrument-sized catastrophe floor (3 × 15m noise, clamped ₹2,000–ceiling), prove it on last month's live trades first, and back it with a real resting stop at the broker.

**Architecture:** The noise-aware hard loss that exists since 2026-11-04 (`exit-discipline/hard-floor.ts`: limit ₹2,000, cap, 3-N band) already *is* the decided rule when its cap is the per-class ceiling and its N is the 15m noise unit. This plan adds a per-class ceiling table, pins the band to N15, writes the replay that the owner decides on, and moves the broker stop (`FLOOR_BROKER_SL`) from the noise floor to the rupee ceiling. All new behaviour is behind settings whose unset value is today's behaviour.

**Tech Stack:** NestJS 10, Prisma, Jest, tsx scripts.

**Spec:** `docs/superpowers/specs/2026-11-25-desk-watcher-design.md` (§5.3, "Decided 2026-11-25"). This is Plan 1 of 4: (1) catastrophe floor, (2) trade agents + level executor, (3) supreme watcher, (4) parallel signal evaluation + capacity. Plans 2–4 are written after Plan 1's replay is reviewed by the owner.

## Global Constraints

- Ceilings (owner-decided 2026-11-25): index options ₹5,000; stock options ₹5,000; GOLD / SILVER ₹7,500; CRUDE / NATURALGAS / other MCX ₹5,000. Minimum ₹2,000. K = 3 × the 15m noise unit.
- Daily max loss, the kill switch, position caps and the owner HOLD list are unchanged and above everything. A HOLD position (e.g. `MAZDOCK29DEC261760PE`) gets no floor action and no broker stop.
- The entry risk check (signal-trader gate `riskCapFor`) keeps today's figures — widening the exit floor must not let bigger trades in.
- Every new setting's unset value = today's behaviour. Turning the new floor on is an env change after the owner reads the replay.
- Never decide or measure on 1m bars; the noise unit is the 15m one (N15).
- Live trading path. Run API tests as `cd apps/api && npx jest <pattern>`; tsc `cd apps/api && npx tsc --noEmit -p tsconfig.json` (~178 pre-existing errors; judge only touched files).
- Commit with explicit pathspecs; message ends `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push. Deploy only after 15:35 IST with no open-position decision pending.

## Review Focus

1. A misconfigured or empty ceiling table must fall back to today's figures, never to "no cap" (a loss must never be uncapped).
2. The band's noise unit must be N15; if N15 is unavailable the band must fail safe (exit at ₹2,000 as today's `BAND_UNMEASURED`), never hold to the ceiling.
3. The broker stop price must be computed from rupees per contract (qty × lot multiplier × contract value), correct for NFO, BFO and MCX (MCX contract-value factor), and never on the wrong side of LTP.
4. The replay must not look ahead: an exit decision at time t uses only bars ≤ t.
5. HOLD-list and manual positions: no stop placed, no floor exit, logged as skipped.

---

### Task 1: Per-class ceiling table and N15 band

**Files:**
- Modify: `apps/api/src/common/utils/loss-limit.ts` (class ceilings), `apps/api/src/modules/exit-discipline/hard-floor.ts` (doc + N15 source), the caller that resolves `nUnderlying` for the hard loss (`exit-discipline/decision.ts:209`) and the caller that builds `HardLossConfig`.
- Test: `apps/api/src/common/utils/loss-limit.spec.ts`, `apps/api/src/modules/exit-discipline/hard-floor.spec.ts` (or existing equivalents).

**Interfaces — Produces:**
- `HARD_LOSS_CEILING_BY_CLASS` env, format `INDEX_OPT:5000,STOCK_OPT:5000,GOLD:7500,SILVER:7500,MCX:5000`. **Unset / `off` = today's behaviour** (limit `HARD_LOSS_EXIT_RUPEES`, cap `HARD_LOSS_CAP_RUPEES`/per-underlying list). Junk entries ignored, valid kept; an empty valid set = today's behaviour.
- `instrumentClass(symbol: string, exchange: string): 'INDEX_OPT' | 'STOCK_OPT' | 'GOLD' | 'SILVER' | 'MCX' | 'OTHER'` (GOLD/SILVER by `mcxUnderlyingOf` exact name; GOLDM/SILVERM count as GOLD/SILVER here — state it in the doc comment; index list = the indices in signal-intake vocabulary `INDEX_ALIASES` keys; `OTHER` → today's figures).
- `lossLimitFor(symbol, exchange, env)` returns `{ limit: 2000, cap: <class ceiling> }` when the table is on and the class is listed — **limit stays `HARD_LOSS_EXIT_RUPEES`, the noise band stays on** (unlike today's GOLD entry, which sets limit = cap).
- The hard-loss band uses the **15m** noise unit of the underlying. If the current `nUnderlying` source is not N15, convert or source N15 (find where N15 is computed for the exit packet — memory: "15m (N15) is the smallest unit"); when N15 is null → `BAND_UNMEASURED` (exit at the limit, today's fail-safe).
- `HARD_LOSS_ABS_RUPEES` (chart-read "exits whatever the chart says", prod 3500): when the table is on, it becomes the class ceiling for that position (the chart may hold to the ceiling, never past it).
- Entry gate `riskCapFor` unchanged: it must keep returning today's figure even with the table on (add a test).

- [ ] Step 1: failing tests — `table unset → today's limit/cap`; `INDEX_OPT NIFTY…CE → {limit 2000, cap 5000}`; `GOLD option → {2000, 7500}` with band on; `junk table → today's`; `band uses N15: loss −2,500, underlying 2.9×N15 against → HOLD_UNDER_N; 3.0×N15 → BAND_UNDERLYING`; `N15 null in band → BAND_UNMEASURED (exit)`; `loss −5,000 on INDEX_OPT → CAP`; `riskCapFor unchanged with table on`; `chart hold ceiling = class ceiling when table on`.
- [ ] Step 2: run, expect FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run `cd apps/api && npx jest src/common/utils src/modules/exit-discipline src/modules/sentinel-executor src/modules/signal-trader` — expect PASS.
- [ ] Step 5: commit `feat(exit-discipline): per-class catastrophe ceilings with the 3×N15 band (off until HARD_LOSS_CEILING_BY_CLASS is set)`.

### Task 2: Replay — last month's live trades, old floor vs new floor

**Files:**
- Create: `apps/api/scripts/sql/export-floor-replay.sql` (read-only), `apps/api/scripts/floor-replay.ts`, spec under `apps/api/src/modules/exit-discipline/floor-replay.spec.ts` (jest rootDir is `src`).

**Interfaces — Consumes:** Task 1's `lossLimitFor` / `hardLossReading` / `instrumentClass` (pure). **Produces:** `npx tsx apps/api/scripts/floor-replay.ts <fixture.json> > floor-replay.md`.
- Fixture rows (from the SQL, 30 days, closed live F&O/MCX `trade_trackers` + their exit reason from the executor audit): tracker id, symbol, exchange, side, qty, lot, entry time/price, actual exit time/price/reason, the contract's 15m bars from entry to session close (or to +3 sessions for carried positions), the underlying's 15m bars and N15 at entry.
- For each trade: replay the **old** rule (today's prod config) and the **new** rule on the 15m path; report per trade: actual exit, old-rule exit, new-rule exit, ₹ for each, and a class tag: `CUT_THEN_RECOVERED` (old rule exited at a loss, price later reached entry or the first target before the new floor), `NEW_LOSES_MORE` (new floor exits deeper than old), `SAME`, `NOT_REACHED`.
- Summary table by class and in total: count of each tag, ₹ difference old vs new, worst single trade under new.
- No look-ahead: the decision at bar t uses bars ≤ t only. A bar touching both floor and recovery counts as the floor (conservative).
- HOLD-list trades and manual trades listed separately, not counted.

- [ ] Step 1: failing tests (tiny synthetic paths): `₹2k cut inside noise that recovers is CUT_THEN_RECOVERED`; `gap through the ceiling exits at the bar's open, NEW_LOSES_MORE`; `no look-ahead (recovery after the floor bar does not count)`; `HOLD trade excluded`.
- [ ] Step 2: run, expect FAIL.
- [ ] Step 3: implement SQL + script (follow `apps/api/scripts/rescore-judge.ts` / `export-judge-rescore.sql` conventions).
- [ ] Step 4: run, expect PASS.
- [ ] Step 5: commit `feat(exit-discipline): floor replay — last month's live trades, ₹2k rule vs catastrophe floor`.
- [ ] Step 6 (controller): export the fixture read-only from prod, run the replay, give the owner the summary. **Owner decides** go / adjust ceilings / K before Task 4's rollout.

### Task 3: Broker stop at the rupee ceiling

**Files:**
- Modify: `apps/api/src/modules/sentinel-executor/domain/floor-broker-sl.ts` (placement mode), `.../services/floor-broker-sl.service.ts`; Test: their specs.

**Interfaces — Produces:**
- `FLOOR_BROKER_SL_AT=noise|ceiling` (unset = `noise`, today's placement). With `ceiling`: the resting STOPLOSS-LIMIT trigger = the contract premium at which net loss = the class ceiling: BUY position `entry − ceiling / (qty × contractValueFactor)`, SELL `entry + …`, rounded to tick **in the protective direction**; limit = trigger ∓ `FLOOR_BROKER_SL_LIMIT_TICKS`. Placed once at entry; **not trailed** (the noise floor's trailing stays in code exits); cancelled on exit as today.
- Never placed if the computed trigger is on the wrong side of LTP (would fire at once) → `SKIP reason 'ceiling_through_ltp'`, and the code floor handles it.
- HOLD-list → `OWNER_HOLD` skip (existing). Table off (Task 1) → `SKIP 'no_ceiling'`.
- Shadow mode records the ceiling placement and, on exit, `would_fill` vs actual exit, same as today's `EXIT_COMPARE`, so a week of shadow shows how often the ceiling stop would have fired.

- [ ] Step 1: failing tests — `NIFTY CE 1 lot 75 @120, ceiling 5000 → trigger 120 − 5000/75 = 53.35 (tick-rounded up)`; `GOLD option uses MCX contract value`; `SELL side mirrors`; `trigger above LTP for a BUY → SKIP ceiling_through_ltp`; `HOLD → OWNER_HOLD`; `FLOOR_BROKER_SL_AT unset → noise placement unchanged`.
- [ ] Step 2: run, expect FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run `cd apps/api && npx jest src/modules/sentinel-executor` — expect PASS.
- [ ] Step 5: commit `feat(sentinel-executor): broker stop at the rupee ceiling (FLOOR_BROKER_SL_AT=ceiling)`.

### Task 4: Rollout (owner-gated)

- [ ] Merge to `main` after 15:35 IST with no open-position decision pending; deploy; all new settings unset (no behaviour change). Verify containers on the new SHA.
- [ ] Owner reviews Task 2's replay → confirms ceilings / K.
- [ ] Set `FLOOR_BROKER_SL_AT=ceiling` (still `FLOOR_BROKER_SL` shadow) for one week; report shadow fills vs actual exits.
- [ ] With owner OK: set `HARD_LOSS_CEILING_BY_CLASS` (new floor live in code); then `FLOOR_BROKER_SL=live` (real resting stops). Recreate the API after 15:35 each time.
- [ ] Night review: list every floor fire; each one is a question for Plan 2's trade agent ("should it have exited first?").
