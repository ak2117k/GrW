# Carry, thesis guard, analysis inputs & judge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an intraday trade reaches the close, the engine decides whether to carry it overnight or exit. A guessed thesis can never exit a trade on its own. Gold and silver are fully wired in. Event days reach the judge. The judge takes a call by default unless there is concrete evidence against it. Missing inputs raise an alert.

**Architecture:** There are five parallel streams (A–E). Each stream owns its files, all on one shared working tree. Cross-stream contracts are fixed in the **Interfaces** blocks; nothing else is shared. Each stream commits locally with explicit pathspecs. The coordinator reviews, then pushes `main`.

**Tech Stack:** NestJS + TypeScript (apps/api), Prisma/Postgres, jest (`--no-cache`), the Angel One SmartAPI SDK (`smartapi-javascript`), @td/shared.

**Spec:** `docs/superpowers/specs/2026-11-04-intraday-carry-and-thesis-guard-design.md` (decisions D1–D15) and `docs/superpowers/specs/2026-11-04-analysis-inputs-and-judge-design.md`.

## Global Constraints

- Signal trading is LIVE with real money. Every behaviour change ships behind an env flag with a safe off value, and the flag's default and rollback are written in its config comment.
- Never push, never touch non-main branches, and never run `git stash`, `git reset` or `git checkout`. Commit only your own files: `git commit -m ... -- <paths>`.
- Disk: C: has about 0.5 GB free. Check `(Get-PSDrive C).Free` before every jest/tsc run, and **stop and report if it is under 250 MB**. Run targeted jest only (`npx jest <paths> --no-cache`), never the full suite. Use unique temp file names.
- `prisma/schema.prisma` is shared by streams B and D. Edit it **only** with the Edit tool on your own model or field block, never Write the whole file. Create migration folders under `prisma/migrations/` named `20261104<hhmm>_<stream>_<name>`.
- Golden snapshots (`apps/api/src/modules/trade-sentinel/golden/__snapshots__/`) are shared by A and B. Update them with `-u` only for your own prompt change, and mention it in your report.
- Bump a prompt's version string whenever its text changes.
- tsc baseline for apps/api is 178 errors. You may not add new errors on lines you changed.
- Never print secrets, never bypass CredentialDecryptor, and never trim ENCRYPTION_KEY.
- Follow existing idioms: pure domain functions plus thin services, comments that explain *why* (dated prod incidents), and `present`/`absent` blocks for packet data.

## Review Focus

1. **The broker says "converted" but the position book still says MIS.** Expected: treat it as not converted, retry once, then exit before the deadline (Task B2 tests `verifyConversion`).
2. **An INFERRED thesis written long after entry, when the underlying price at entry is unknown.** Expected: the invalidation is kept as record-only and never passes (Task A1 test `keeps invalidation record-only when entry underlying unknown`).
3. **GOLD alongside GOLDM, GOLDGUINEA and SILVER100 symbols in the per-underlying loss limit.** Expected: only the GOLD underlying gets ₹7,500, and GOLDM keeps the default (Task A3 tests).
4. **The event calendar is unreachable or empty.** Expected: the judge packet says `events: absent(<reason>)`, never "no event today" (Task D1 test).
5. **The judge default flag set to `skip`.** Expected: today's behaviour exactly, with the existing judge specs passing unchanged (Task D3).

---

## Stream A — thesis guard, carry-forward framing in the gate, per-underlying loss limit

Owns these files:
- `apps/api/src/modules/trade-sentinel/services/thesis.service.ts`
- `apps/api/src/modules/trade-sentinel/prompts/thesis-prompt.ts`
- `apps/api/src/modules/trade-sentinel/services/thesis-guard.ts` (new)
- `apps/api/src/modules/exit-discipline/{gate.ts,types.ts,decision.ts,hard-floor.ts}`
- `apps/api/src/modules/sentinel-executor/services/exit-gate.service.ts`
- `apps/api/src/common/utils/loss-limit.ts` (new)

### Task A1: Thesis guard — the underlying at entry goes into inference, and an invalidation already breached at entry is discarded

**Files:**
- Create: `apps/api/src/modules/trade-sentinel/services/thesis-guard.ts`, plus its spec
- Modify: `thesis.service.ts`: `InferenceRequest` gains `underlyingAtEntry: number | null`, `dayHigh`, `dayLow` and `vwap` (each `number | null`). Find them where the context packet gets the underlying.
- Modify: `thesis-prompt.ts`: tell the model where the underlying was at entry, and that a level already crossed against the position before entry is not a valid invalidation.

**Interfaces:**
- Produces: `guardInferredThesis(t: { direction: 'LONG'|'SHORT'; levelPrice: number|null; invalidation: number|null; reason: string }, underlyingAtEntry: number|null): { levelPrice: number|null; invalidation: number|null; reason: string; discarded: null | 'BREACHED_AT_ENTRY' | 'ENTRY_UNKNOWN' }`

- [ ] Write the failing tests in `thesis-guard.spec.ts`:
  - `LONG invalidation 2343.9 with underlying 2310 at entry → invalidation null, discarded BREACHED_AT_ENTRY, reason ends with "(invalidation 2343.9 already breached at entry 2310, discarded)"`
  - `SHORT invalidation 100 with underlying 105 → discarded`
  - `LONG invalidation 2290 with underlying 2310 → unchanged, discarded null`
  - `keeps invalidation record-only when entry underlying unknown → invalidation unchanged, discarded ENTRY_UNKNOWN`
- [ ] Run `npx jest apps/api/src/modules/trade-sentinel/services/thesis-guard.spec.ts --no-cache`. Expect FAIL.
- [ ] Implement it. In `infer()`, apply it to the parsed draft before returning. Equality counts as breached.
- [ ] Run it. Expect PASS. Then run `thesis.service.spec.ts` and the golden spec (`-u` for the thesis prompt only).
- [ ] Commit: `feat(trade-sentinel): thesis guard — entry underlying in inference, breached-at-entry invalidation discarded`.

### Task A2: An INFERRED thesis can't pass the gate on its own

**Files:**
- Modify: `exit-discipline/types.ts`: facts gain `thesisSource: 'INFERRED' | 'USER' | null`
- Modify: `decision.ts` (`buildGateFacts`)
- Modify: `exit-gate.service.ts`: pass the stored thesis source through
- Modify: `gate.ts`: `THESIS_INVALIDATION` / `THESIS_LEVEL`

- [ ] Write the failing tests in `gate.spec.ts`:
  - `INFERRED thesis beyond invalidation by a clear margin → clause pass false, note "inferred thesis — record only", outcome not THESIS_BROKEN`
  - `USER thesis, same facts → THESIS_BROKEN, as before`
  - `INFERRED thesis + HARD_MAX_LOSS breached → PASS via HARD_MAX_LOSS`
- [ ] Implement it behind `GATE_INFERRED_THESIS_RECORD_ONLY` (on unless exactly `"false"`). `thesisSource` null behaves as before.
- [ ] Run the `exit-discipline` and `sentinel-executor` specs. Expect PASS.
- [ ] Commit.

### Task A3: Per-underlying hard loss limit (GOLD ₹7,500)

**Files:**
- Create: `apps/api/src/common/utils/loss-limit.ts`, plus its spec
- Modify: `hard-floor.ts` (`hardLossTrip`, `HARD_LOSS_CAP_RUPEES` handling) and the `maxLossPerTrade` source in `exit-gate.service.ts`

**Interfaces:**
- Produces: `lossLimitFor(underlying: string | null, env?: Record<string,string|undefined>): { limit: number | null; cap: number | null }`. It reads `HARD_LOSS_EXIT_RUPEES_BY_UNDERLYING` (format `GOLD:7500,SILVER:5000`; the code default is `GOLD:7500`). For a listed underlying, limit = cap = the listed value (no noise band); otherwise it falls back to `HARD_LOSS_EXIT_RUPEES` / `HARD_LOSS_CAP_RUPEES`. Underlying names match exactly after `mcxUnderlyingOf`, so GOLDM ≠ GOLD. Stream C also uses this function.

- [ ] Write the failing tests:
  - `GOLD → {limit 7500, cap 7500}`
  - `GOLDM → default {2000, 3000}`
  - `NIFTY → default`
  - `env "off" → defaults for all`
  - `junk entry ignored`
  - `hardLossTrip for a GOLD option at −₹7,600 net trips; at −₹2,500 does not`
- [ ] Implement it and wire it in.
- [ ] Run the specs. Expect PASS.
- [ ] Commit.

---

## Stream B — intraday close: CARRY or EXIT, broker conversion, scoring, carry-forward deadline

Owns these files:
- `apps/api/src/modules/trade-sentinel/services/{square-off-look.ts,judge-gate.ts}`
- `apps/api/src/modules/trade-sentinel/prompts/sentinel-system-prompt.ts` (close/deadline wording only)
- the broker adapter interface and the per-user broker session (`convertPosition`)
- new module `apps/api/src/modules/intraday-carry/`
- the `IntradayCarryDecision` model and migration
- `apps/api/src/modules/paper-sentinel/paper-exit.ts` (paper simulation only)

### Task B1: A carry-forward position has no close deadline

- [ ] Write the failing tests in `square-off-look.spec.ts`:
  - `F&O CARRYFORWARD, non-expiry, 8 min to close → null (no fire, no framing)`
  - `F&O CARRYFORWARD on expiry day → EXPIRY_CLOSE look as today`
  - `F&O INTRADAY → SESSION_CLOSE look as today`
- [ ] Add `productType: string | null` to `SquareOffInput`; null keeps today's behaviour. Thread it in from the cycle.
- [ ] In the system prompt, for carry-forward non-expiry positions add: "held overnight by the user's choice; the session close is not a reason to exit". Bump the prompt version and update goldens.
- [ ] Run the specs. Commit.

### Task B2: `convertPosition` on the broker adapter, verified against the position book

**Interfaces:**
- Produces: `BrokerAdapter.convertPosition(p: { exchange; symboltoken; tradingsymbol; transactiontype: 'BUY'|'SELL'; quantity: number; oldproducttype: 'INTRADAY'; newproducttype: 'CARRYFORWARD' }): Promise<{ accepted: boolean; message: string }>`
- Produces: the pure function `verifyConversion(positions: Array<{tradingsymbol; producttype; netqty}>, symbol: string, qty: number): 'CONVERTED' | 'NOT_CONVERTED' | 'POSITION_GONE'`

- [ ] Write the failing tests for `verifyConversion`:
  - `NRML row with full qty → CONVERTED`
  - `still INTRADAY → NOT_CONVERTED`
  - `split rows (part converted) → NOT_CONVERTED`
  - `no row → POSITION_GONE`
- [ ] Implement both. **The SDK never rejects**: a `{}` or `{status:false}` response is `accepted:false`, and success is decided only by `verifyConversion` on a fresh position book.
- [ ] Commit.

### Task B3: The CARRY/EXIT decision at the close (live + paper)

**Files:**
- Create: `intraday-carry/domain/carry-decision.ts` (pure)
- Create: `intraday-carry/intraday-carry.service.ts`
- Create: the `IntradayCarryDecision` model and migration (id, userId, trackerId|tradeId, symbol, mode `live|paper`, decision `CARRY|EXIT`, reason, facts JSON, conversion status, broker message, decidedAt, executedAt)

**Interfaces:**
- Consumes: the judge's verdict on the forced close look, which gains a `closeDecision: 'CARRY' | 'EXIT'` field in its schema for INTRADAY positions only. Also `lossLimitFor` (A3, read-only) for the overnight risk fact.

Rules:
- **When it runs:** only INTRADAY positions. Open the window early enough that the conversion can be verified at least 3 minutes before the broker's MIS square-off. Confirm Angel's NFO/BFO/MCX MIS square-off times from code or config; don't guess.
- **Skip cases:**
  - Expiry-day contract → EXIT, never CARRY.
  - AI_AUTO_EXIT_HOLD → do nothing, and log it.
- **CARRY** → convert → verify (retry once, 30 s apart). If still not converted by the deadline minus 3 minutes → EXIT at market through the existing exit executor.
- **Daily cap:** if `AI_AUTO_EXIT_DAILY_CAP` blocks an EXIT, log `CAP_BLOCKED_BROKER_SQUARE_OFF`.
- **Who:** live only for users in `INTRADAY_CARRY_USERS` (comma-separated user ids; empty = nobody). Paper positions are simulated: the paper trade stays open overnight or is closed by `paper-exit.ts`.
- **Flag:** `INTRADAY_CARRY=live|off`, default `live`.
- [ ] Tests (pure `carry-decision.ts`):
  - `expiry today → EXIT`
  - `held → NONE`
  - `user not allowed → paper-only`
  - `CARRY + NOT_CONVERTED at deadline-3m → EXIT`
  - `cap exhausted + EXIT → CAP_BLOCKED_BROKER_SQUARE_OFF`
- [ ] Implement it. Persist a row for every decision. Commit.

### Task B4: Next-session scoring of carry/exit decisions

- [ ] A prod cron at 10:20 IST on trading days fills on each decision row:
  - `gapPct`
  - first-hour `maxAfter` / `minAfter`
  - `pnlCarry` vs `pnlExit` at 10:15
  - `verdict RIGHT|WRONG`

  The bars come from candles_1m or broker history. Follow `ai_exit_outcomes`.
- [ ] Add a line to the nightly self-review / night report: "carry calls: n, right k, Δ₹".
- [ ] Tests on the pure scorer, then commit.

---

## Stream C — gold/silver wiring: data, entry engine, entry sizing, risk-manager block

Owns these files:
- `apps/api/src/modules/market-hub/*` (pinned lines)
- the options-chain / OI snapshot code for MCX
- `apps/api/src/modules/entry-engine/domain/{engine-inputs.ts,entry-decision.ts,news-theme.ts}` and the entry-engine service
- `apps/api/src/modules/signal-trader/domain/gate.ts`
- `trade-engine/services/risk-manager.service.ts` (only if the risk-manager block is a bug)

### Task C1: Pin GOLD and SILVER near-month futures, plus the underlying stock of any open stock-option position

- [ ] Tests:
  - the pinned set includes the near-month `GOLD…FUT` and `SILVER…FUT`, rolling at expiry like CRUDEOIL
  - an open `LAURUSLABS…CE` tracker pins `LAURUSLABS-EQ` (NSE 19234), and closing the position releases it
  - the slot budget is respected (30)
- [ ] Implement following the e1e2001 pinned-lines pattern. Commit.

### Task C2: GOLD/SILVER option chain snapshots into `oi_snapshots`

- [ ] Use the existing snapshot path that serves CRUDEOIL, over REST (no feed slots).
- [ ] Test: GOLD's expiry/strike window is resolved, and `oiCheck` on GOLD returns a verdict other than `NO_DATA` from a fixture.
- [ ] Commit.

### Task C3: GOLD and SILVER join the entry engine (still paper)

- [ ] Add `'GOLD'` and `'SILVER'` to `ENGINE_UNIVERSE`.
- [ ] Add news maps:
  - `NEWS_MATCH`: `GOLD: { symbols: ['GOLD','GOLDM'], sectors: ['MCX BULLION'] }`, and SILVER the same way
  - headline subjects: gold / bullion / yellow metal / Comex gold, excluding company names such as "Muthoot Gold" and "gold loan"
  - `SUBJECT_SECTORS` `'MCX BULLION'`
- [ ] Event day: on an event day that affects the underlying (`eventContextFor` from D1), the engine's decision reasons include the event, and the news component treats EVENT_RISK items as "move expected" (no direction).
- [ ] Tests:
  - `"Gold rises as dollar weakens"` matches GOLD
  - `"Muthoot gold loan NPAs"` does not
  - the universe contains GOLD and SILVER
- [ ] Commit.

### Task C4: Entry sizing ×contract value; GOLD risk cap ₹7,500; why the risk manager blocked GOLD

- [ ] In `sizeEntry`, `perUnit` is multiplied by `contractValueFactor(c.exchange, c.tradingsymbol)`, so `riskRupees` is real rupees.
- [ ] The cap used for the risk check comes from `lossLimitFor(underlying).cap` (A3), falling back to today's cap.
- [ ] Tests:
  - `GOLD CE 566.5, SL 424.5, lot 1 → riskRupees 14200`
  - `NIFTY unchanged`
- [ ] Investigate the `liveGateBlocked=risk_manager` case on today's GOLD decision. Read the code and query prod read-only with unique /tmp names (see ssh/psql notes in memory). If the block comes from the unscaled factor or a wrong cap, fix it with a test. If the account genuinely lacks funds, report and don't change anything.
- [ ] Commit.

---

## Stream D — event days, news EVENT_RISK, judge default TAKE

Owns these files:
- `apps/api/src/modules/news-events/events/*`
- `apps/api/src/common/utils/market-events.ts`
- `apps/api/src/modules/news-impact/*`
- the `news_impacts` event-risk column and migration
- `apps/api/src/modules/signal-trader/domain/{judge.ts,signal-trader.config.ts}` and the signal judge prompt/packet

### Task D1: `eventContextFor` — one event view built from both calendars

**Interfaces:**
- Produces `apps/api/src/modules/news-events/events/event-context.ts`:
  - `eventContextFor(underlying: string, at: Date, deps): Promise<EventContext>`
  - `type EventContext = { status: 'present'; events: Array<{ name: string; at: string; impact: 'high'|'medium'|'low'; affects: string[]; expectMove: boolean }> } | { status: 'absent'; reason: string }`

  It merges `market_events` (macro schedule, plus a new `us_election` kind) with `MARKET_EVENT_DAYS`. Mapping: US macro and elections affect GOLD, SILVER, CRUDEOIL, NIFTY, BANKNIFTY and SENSEX; RBI and India CPI affect the indices; OPEC affects CRUDEOIL. The window runs from the event's IST session through the next session's first 2 h.
- [ ] Tests:
  - `2026-11-04 GOLD → US_MIDTERM_RESULTS, expectMove true`
  - `FOMC date → GOLD and NIFTY affected`
  - `repository throws → absent with reason`
  - `no events → present with []`
- [ ] Commit.

### Task D2: The news reader tags EVENT_RISK

- [ ] Add a `volatility: 'EVENT_RISK' | null` (or similar) field to the impact schema and prompt, and an `event_risk boolean` column. Prompt rule: scheduled, binary or political-macro outcomes (elections, rate decisions, war/ceasefire) affecting GOLD, SILVER, CRUDEOIL or the indices are EVENT_RISK even when the direction is NEUTRAL.
- [ ] Bump the prompt version. Test the parsing and default (null on old rows). Commit.

### Task D3: Judge default TAKE + event context in the judge packet

**Files:** `judge.ts`, its prompt, `signal-trader.config.ts`

- [ ] Add a `SIGNAL_JUDGE_DEFAULT=take|skip` flag (default `take`). With `take`, the prompt says: TAKE unless there is concrete evidence against — price past T1, the stop already broken, entry outside tolerance, expiry-day or illiquid contract, a hard risk. Unavailable data and mixed news are not reasons to SKIP. On an event day affecting the underlying, missing data counts for nothing.
- [ ] Add `events: eventContextFor(...)` to the packet.
- [ ] Bump the prompt version.
- [ ] Tests:
  - with `skip`, the prompt is byte-identical to today
  - with `take`, it contains the default-take rule
  - the packet carries events present/absent
- [ ] Commit.

---

## Stream E — daily inputs health alert

Owns: new module `apps/api/src/modules/inputs-health/` and its registration in app.module.

### Task E1: Inputs health check plus a Telegram alert

- [ ] Pure checker `checkInputs(snapshot): Problem[]`. During each watched underlying's session it raises:
  - `NO_BARS`: no 1m bars for more than 10 min. Covers the ENGINE_UNIVERSE, the pinned futures, and the underlyings of open positions.
  - `NO_CHAIN`: no oi_snapshot for more than 30 min, for underlyings that have options.
  - `NEWS_SILENT`: no news_impacts for more than 60 min in market hours.
  - `ENGINE_NEWS_EMPTY`: the entry engine's news was NO_DATA on more than 80% of the session's checks for an underlying.
- [ ] A cron every 15 min sends one Telegram alert per (problem, underlying, day) through the existing alert/telegram notifier. Flag `INPUTS_HEALTH=on|off`, default on.
- [ ] Tests for each problem kind, dedupe per day, and no alerts outside the session. Commit.

---

## Integration (coordinator)

- [ ] After all streams: run tsc (≤ 178 errors) and the targeted jest of every touched module once.
- [ ] Review the diff per stream, then push `main` after 15:35 IST.
- [ ] Set prod env: `INTRADAY_CARRY_USERS=<owner id>` (owner approved live from day one), with a backup of api.env first.
