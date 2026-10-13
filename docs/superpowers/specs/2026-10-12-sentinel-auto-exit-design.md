# Sentinel Auto-Exit (live) — Design

**Date:** 2026-10-12 · **Status:** draft for owner review · **Owner decision:** "Live, fully automatic" (2026-10-12)

## 1. Goal

When the trade sentinel (LLM, already live in shadow mode) issues **EXIT_NOW** on one of the owner's real
Angel One F&O positions, GrW places the closing order on Angel One **by itself**, without a tap — inside hard
guards that make a wrong action bounded, visible and switchable off.

Success: on an EXIT_NOW for an open F&O tracker, within ~10 s the broker position is flat (or an attempt row
says exactly why not); no order is ever placed that opens, adds to, or exceeds a position.

## 2. What the owner decided (2026-10-12)

| Decision | Value |
|---|---|
| Authority | Live, fully automatic (no per-trade confirmation) |
| Rollout | `dry-run` first (everything except the order), then `live` |
| Daily cap | at most **5** AI exits per user per IST day (config) |
| Market order rejected | one fallback: aggressive LIMIT at LTP − 2% (sell) / + 2% (buy-to-cover), rounded to tick size |
| Static IP | 157.10.98.70 registered as app "GrWW" in the owner's SmartAPI account |

## 3. Scope

**In:** real broker positions tracked in `trade_trackers` (`kind = 'POSITION'`), exchanges **NFO, BFO, MCX**,
the owner's account (allow-list), verdict `EXIT_NOW` only.

**Out:** holdings, cash equity, opening/adding/reversing, HOLD/EXIT_ARMED/ESCALATE, overnight-review verdicts
(`EXIT_AT_OPEN`, `TIGHTEN_AT_OPEN` — a later step), core paper positions (M4 has its own lifecycle; M5+),
other tenants, push notifications (no owner channel exists yet — §8).

## 4. Architecture

A new module `apps/api/src/modules/sentinel-executor/`, **separate from `trade-sentinel`**:

```
sentinel cycle (unchanged, shadow) ──writes──▶ sentinel_verdicts
                                                   │ poll every 5 s (new EXIT_NOW rows only)
                                                   ▼
                                     SentinelExitExecutor ──▶ guards ──▶ UserBrokerSession.placeOrder
                                                   │                              (owner's own Angel session)
                                                   └──writes──▶ ai_exit_executions (one row per verdict)
```

- **Decoupled by the database.** The executor reads verdict rows; it never imports `trade-sentinel`, and
  `trade-sentinel` never imports it. The existing structural test ("the sentinel cannot reach anything that
  places an order") stays true and unchanged. Switching the executor off never touches the sentinel.
- **Order path reuse.** Orders go through the existing per-user `UserBrokerSession` (auto-execution's
  `PerUserBrokerSessionFactory` + credential vault decrypt lease) — the same path that already maps
  `OrderRequest` to SmartAPI and supports `ordertag`. No second order mapper.
- **Rejected alternatives:** sentinel calls the executor directly (couples them, breaks the shadow guarantee);
  route through the M4 core lifecycle (it manages core paper positions, not broker trackers).

## 5. Flow for one verdict

1. **Pick up.** Every 5 s (setInterval gated by `bootJobsEnabled()`; no `@Cron`), read `sentinel_verdicts` with
   `verdict = 'EXIT_NOW'`, `createdAt` within the freshness window, `userId` in the allow-list, and no
   `ai_exit_executions` row yet. Oldest first, sequential per user.
2. **Claim.** Insert the `ai_exit_executions` row (`status = CLAIMED`, unique on `verdictId`) **before** any
   broker call. A unique-violation means another pass has it — skip. This is the idempotency anchor.
3. **Guards** (any failure → row `SKIPPED` with the reason; nothing sent):
   - executor enabled; user in allow-list;
   - verdict age ≤ `AI_AUTO_EXIT_MAX_VERDICT_AGE_SEC` (default 90);
   - tracker exists, `status = OPEN`, `kind = POSITION`, exchange ∈ {NFO, BFO, MCX};
   - the tracker's exchange is in session (market-hub `SessionClock`, holidays included);
   - today's count of `ai_exit_executions` with `status ∈ {PLACED, FILLED, DRY_RUN}` for the user < daily cap
     (cap reached → `SKIPPED: DAILY_CAP` + one WARN per day).
4. **Fresh broker read.** One `getPositionsEnvelope()` on the owner's session right before ordering. Find the
   row with the tracker's `symboltoken` and exchange. If the envelope is not an answer (`status !== true`) →
   `FAILED: BROKER_READ`. If `netqty = 0` / row missing → `SKIPPED: ALREADY_FLAT`.
5. **Size and side.** `quantity = |netqty|` (whole position, never more). `side = netqty > 0 ? SELL : BUY`.
   `positionType` from the row's `producttype` (INTRADAY / CARRYFORWARD / DELIVERY; anything else →
   `SKIPPED: UNKNOWN_PRODUCT`). Symbol/token/exchange from the broker row, not the tracker.
6. **Dry-run.** In `dry-run` mode: row `DRY_RUN` with the exact order that would be sent; log
   `[ai-exit] DRY-RUN would SELL 100 CRUDEOIL15OCT268950CE (CARRYFORWARD) at MARKET — verdict <id>: <reason>`.
7. **Live.** `placeOrder({…, orderType: 'MARKET'}, orderTag = 'aix-' + verdictId(-truncated to Angel's
   ordertag limit))`. Result `PLACED` with broker order id, or a rejection:
   - if the rejection says market orders aren't allowed for the instrument → **one** fallback LIMIT at
     LTP ∓ 2% (from the broker row's `ltp`), rounded to the contract tick size → `PLACED` / `REJECTED`;
   - any other rejection → `REJECTED` with the broker's message (no retry; the next EXIT_NOW verdict gets its
     own attempt, still subject to the cap).
8. **Confirm.** The tracker reconcile (now every 10 min through MCX hours) closes the tracker when the broker
   book shows it flat; the executor also re-reads positions once ~10 s after placing and records
   `FILLED` (flat) or leaves `PLACED`. Never a second order from the confirm step.

## 6. Data

New table `ai_exit_executions` (expand-only migration):

| column | notes |
|---|---|
| `id` cuid, `userId`, `verdictId` **unique**, `trackerId` | |
| `symbol`, `exchange`, `token`, `side`, `quantity`, `productType`, `orderType`, `limitPrice?` | what was / would be sent |
| `mode` | `dry-run` \| `live` |
| `status` | `CLAIMED` \| `SKIPPED` \| `DRY_RUN` \| `PLACED` \| `FILLED` \| `REJECTED` \| `FAILED` |
| `reason` | guard/broker reason (no secrets) |
| `brokerOrderId?`, `brokerMessage?` | |
| `verdictReason` | copy of the sentinel's reason, for review |
| `createdAt`, `updatedAt` | |

A row left `CLAIMED` by a crash is never re-sent: on boot, `CLAIMED` rows older than 60 s become
`FAILED: INTERRUPTED` (an order may or may not have reached the broker; the confirm read and the tracker show
the truth). Duplicate-order safety comes from the unique claim + Angel `ordertag`.

## 7. Configuration (all in `api.env`; defaults are safe)

| var | default | meaning |
|---|---|---|
| `AI_AUTO_EXIT_ENABLED` | `false` | master switch |
| `AI_AUTO_EXIT_MODE` | `dry-run` | `dry-run` \| `live` (`live` requires ENABLED) |
| `AI_AUTO_EXIT_USER_IDS` | empty | comma-separated allow-list (owner's userId) |
| `AI_AUTO_EXIT_DAILY_CAP` | `5` | per user per IST day |
| `AI_AUTO_EXIT_MAX_VERDICT_AGE_SEC` | `90` | freshness window |
| `AI_AUTO_EXIT_LIMIT_FALLBACK_PCT` | `2` | aggressive LIMIT offset when MARKET is refused |

The core kill switch does **not** block these exits (exits are never blocked, CLAUDE.md §9). Turning the
executor off is `AI_AUTO_EXIT_ENABLED=false` + API restart (seconds).

## 8. Visibility

- One `LOG`/`WARN` line per attempt (`[ai-exit] …`), never credentials.
- `GET /api/sentinel-executor/executions` (owner, newest first) and a small "AI exits" list in the existing
  sentinel panel on the Charts page showing status, reason, order id.
- Push alert (Telegram) is a follow-up: no owner notification channel exists in the app today.

## 9. Testing

- Unit (pure): guard evaluation table; side/qty/product from broker rows (long, short, intraday, carry-forward,
  netqty 0, unknown product); LIMIT fallback price and tick rounding; daily-cap counting across IST midnight.
- Service (fakes for prisma, session factory, clock): claim-before-call; duplicate verdict → one attempt;
  dry-run sends nothing; live sends exactly one order with the ordertag; MARKET refusal → one LIMIT; other
  rejection → no retry; broker read not answered → `FAILED`, no order; stale verdict / closed exchange /
  non-F&O / holdings → `SKIPPED`; boot sweep turns stale `CLAIMED` into `FAILED: INTERRUPTED`.
- Structural: `trade-sentinel` still cannot reach any order-placing code (existing spec unchanged and green);
  the executor module imports nothing from `trade-sentinel`.
- Production gate (owner + me): run `dry-run` for one live MCX/NFO session, compare each `DRY_RUN` row with the
  broker book, then switch to `live`.

## 10. Risks

- **An LLM mistake sells a winner.** Bounded by: EXIT_NOW only (high confidence enforced by the agent),
  whole-position close only, daily cap, dry-run gate, one switch to stop.
- **Market order on an illiquid option fills badly.** Accepted by the owner; the LIMIT fallback only applies
  when MARKET is refused.
- **Session/IP problems at order time** (key not switched, static IP mismatch) → `REJECTED` with the broker
  message; nothing retries automatically.
- **Duplicate orders** — prevented by the unique claim row before the call and Angel `ordertag`.
