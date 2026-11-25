# AI message reader — every Telegram post read and cross-checked by AI

Date: 2026-11-25 · Status: DRAFT for owner approval · Area: `signal-intake`, `signal-trader`, `ai-gateway`

## 1. Intent — why

On 2026-11-25 at 09:31 IST *Stock Gainers (SEBI Registered)* posted
"STAY CAUTIOUS — ONLY INDEX SHOWING STRENGTH". The owner calls it the most important message of the
morning. The app filed it as `NOISE / no-instrument` and nothing ever used it. The free rule pre-filter
only accepts a post that names a vocabulary instrument (NIFTY, CRUDE, RELIANCE…); "index" and "stocks"
in general are not instruments, so a market-wide breadth warning is indistinguishable from "good morning".

Over the last 7 days the channels posted 919 messages (~130/day). Text posts are classified by rules only;
the LLM sees images (capped 120/day) and a few "unsure" posts. 123 posts were dropped as `no-instrument`.

Owner's ask (in their words): use AI to read **all** Telegram messages — token cost is not a concern — and
let the AI help conclude things by **verifying the message against our own data while it gives its
verdict**. It must be **quick**, and it must handle **several messages arriving at once**; decisions are
then taken on its output.

## 2. Goals, non-goals, anti-goals

**Goals**
- G1. Every text Telegram post (and every image post the vision reader already handles) gets one AI
  reading: kind, the channel's claims, and a verdict on each claim checked against our live data.
- G2. Market-wide claims (breadth, "index strong / stocks weak", "stay cautious", sector rotation, FII
  flow, gap expectations) are first-class, not only per-instrument views.
- G3. Fast: p50 ≤ 15 s and p95 ≤ 30 s from the post's `receivedAt` to a stored verdict.
- G4. Concurrent: a burst of N posts is read in parallel (default pool 8), never one-behind-another.
- G5. Verified notes are read by the decisions that matter: the signal judge (live and paper), the
  night review, and the owner (alert + a UI list).

**Non-goals**
- Not a new trading strategy. A verdict never places or blocks an order by itself.
- No change to risk limits, lot caps, the kill switch or the live-start time.
- Not replacing the image (vision) reader; it keeps its own path and cap.

**Anti-goals** (a failure even if it "works")
- A slow AI read delaying a live trade call. The current parser path for calls must not wait on the reader.
- The AI's reading of a trade call silently changing what gets traded before it has a track record.
- A verdict with no numbers behind it ("CONFIRMED" with no data cited) — every verdict carries its evidence.
- Silent absence (GrW's dominant bug shape): the reader failing for hours with no one noticing.

## 3. Constraints (from the code and prod)

- **AI capacity (checked 2026-11-25).** Prod runs `AI_AGENTS=on` + `SENTINEL_JUDGE=vertex`, so
  `signal.*` jobs bypass the shared sentinel slot (`agentGatesJob`, `ai-assist/assist-slot.ts`) and run in
  the **reading** agent with per-job limits (`config/ai-agents.json`: parse/vision/info/image-setup 2
  each, news.impact 2, news.sentiment 3). Every agent call also passes the project-wide limiter
  (`ai-gateway/agents/global-limiter.ts`): `AGENTS_GLOBAL_CONCURRENCY` 16, `AGENTS_TRADING_RESERVE` 6 →
  non-trading jobs share 10, halved to 5 for 60 s after a Vertex 429. The reader is a **`signal.read`
  registry entry on the reading agent** (concurrency 8), not a separate in-API pool, and must never use
  the trading reserve. With agents off / `cli` transport the reader is **off** (it would land back on the
  single shared slot and cannot meet G3/G4).
- **Model.** Haiku 5.5 is not enabled on the Vertex project; "haiku" jobs already map to Sonnet 5.5. The
  reader uses **Sonnet 5.5** (speed over Opus). Configurable `MESSAGE_READER_MODEL`.
- **Market data.** The judge already builds a market packet (`SignalContextService.build`: index moves,
  breadth A/D, VIX, chain, news) and a 15m trend block. The reader reuses these builders, not new ones.
- **Every AI call is recorded** in `ai_calls` via the gateway recorder (job `signal.read`).
- **AI agents split.** Prod runs three agent containers (`AI_AGENTS=on`). The reader is placed in the
  group that already owns signal intake (builder confirms in `ai-gateway/agents/agent-registry.ts`).
- **Push = deploy**, guard is NSE hours; deploys wait until after 15:35 IST.
- **Telegram owner alerts are not configured on prod** (`TELEGRAM_ALERT_*` empty). Alerts written by this
  feature reach no one until the owner sets them; the UI list does not depend on that.
- Timeframes: nothing is decided on 1m bars; 15m is the smallest unit (owner rule).

## 4. Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **A (chosen)** | **One AI call per message that reads and verifies together.** On arrival the app builds the data packet *in parallel* with reading; the AI gets message + packet and returns kind, claims, verdicts, evidence in one strict-JSON reply. | One round-trip (~10 s), simplest, evidence attached to every verdict. Data the AI needs must be in the packet up front. |
| B | Two AIs: a reader, then a checker that fetches whatever data it decides. | More flexible on odd claims; ~2× slower, more parts to fail. |
| C | Keep rules; also send rule-dropped posts to AI. | Smallest change, but rules still own everything they wrongly accept; not "AI reads all". |

Owner picked **A** (2026-11-25), with speed and multi-message concurrency as hard requirements.

## 5. Design

### 5.1 Flow per message

```
telegram post arrives (TelegramIngest → signal-intake)
 ├─ existing rule path runs exactly as today (calls still go to signal-trader from the parser) ──┐
 └─ reader.enqueue(message)                                                                       │
      ├─ build packet (parallel): index snapshot, breadth, sectors, VIX, instruments named →     │
      │    15m + daily bars + chain OI, recent posts from same channel (last 30 min), today's     │
      │    verified market notes                                                                  │
      ├─ AI read (pool slot, Sonnet 5.5, strict JSON)                                             │
      └─ store message_readings row  ──► notes for judge / night review / UI / alert ◄────────────┘
```

The reader never blocks the rule path. A call the parser accepts goes to signal-trader immediately as now.

### 5.2 The AI reply (strict JSON schema)

```
kind: CALL | UPDATE | INFO | RECAP | NOISE
scope: MARKET | SECTOR | INSTRUMENT
claims: [{
  text,                       // the claim in plain words ("stocks weak, index strong")
  subject,                    // MARKET | sector name | underlying
  bias: BULL | BEAR | NEUTRAL | CAUTION,
  horizon: INTRADAY | DAYS | WEEKS,
  verdict: CONFIRMED | CONTRADICTED | UNCLEAR | NOT_CHECKABLE,
  evidence: [{ fact, value, source }],   // must cite packet numbers; empty only for NOT_CHECKABLE
}]
call?: { ...same shape the parser produces }   // when kind = CALL / UPDATE (shadow, §5.4)
summary                                        // one line for the owner
```

Validation rejects a CONFIRMED/CONTRADICTED verdict with empty evidence (stored as UNCLEAR, flagged).

### 5.3 Speed and concurrency

- Job `signal.read` in `config/ai-agents.json`: agent `reading`, concurrency 8 (env
  `AGENT_SIGNAL_READ_CONCURRENCY`). FIFO; a burst of 8 is read at once. Under global-limiter contention
  the existing `signal.parse` / `signal.vision` keep their slots (they feed live calls); the reader waits.
  Global ceiling change: see §6 (owner answer on Vertex quota).
- **Image posts:** the reader does not call the model on the image again. When the vision reader stores
  its result (INFO/SIGNAL/UPDATE), the reader runs on the vision output text + caption (trigger = vision
  done, so latency is measured from that point too). The vision 120/day cap is unchanged.
- Packet building is parallel (`Promise.all`) and time-boxed (`MESSAGE_READER_PACKET_MS`, default 3 s);
  a slow source is passed as `{status:'unavailable', reason}` rather than waited on.
- AI call timeout `MESSAGE_READER_TIMEOUT_MS` (default 25 s); one retry while the post is < 5 min old.
- Posts older than `MESSAGE_READER_MAX_AGE_MIN` (default 30) at dequeue are stored `STALE`, not read —
  except during a backlog drain the owner starts by hand.
- Cache by `text_hash` + 15-minute bucket: a forwarded duplicate reuses the reading.
- Latency is stored per row (`queued_ms`, `packet_ms`, `ai_ms`) so G3 is measured, not assumed.

### 5.4 Trade calls: shadow first

For posts the AI reads as CALL/UPDATE, the reader stores its own parse next to the rule parser's and a
`parse_agrees` flag (instrument, side, strike, entry band, SL, targets). It does **not** create signals or
reach signal-trader. Posts the AI reads as CALL that the rules dropped are flagged `missed_by_rules`.
Promotion of the AI parser to primary is a separate later decision after ≥ 1 week / ≥ 50 calls of
agreement data — not part of this build.

### 5.5 Who uses the readings

- **Signal judge** (`signal-trader.runJudge`): `channelViews` gains a `verifiedNotes` block — today's
  readings with verdict CONFIRMED or CONTRADICTED for MARKET scope, the call's sector, and the call's
  underlying, newest first, max 10, each with channel, time, claim, verdict, evidence. The judge prompt
  says these are context, weighted by verdict, never a trigger. Same packet for paper and live judging.
- **Night review**: each claim is scored next day against what the market did, building per-channel
  *information accuracy*. `info-outcome.ts` only scores BULL/BEAR on one underlying's close, so new rules
  (builder's call on the thresholds, fixed before the first score, all on daily/15m bars):
  - INSTRUMENT BULL/BEAR: the existing scorer.
  - MARKET BULL/BEAR: NIFTY close-to-close vs 0.3×ATR band.
  - CAUTION: right if the rest-of-session NIFTY range ≥ its 20-day median range, or NIFTY falls ≥ 0.3×ATR.
  - Relative breadth ("index strong, stocks weak"): right if NIFTY return > 0 and session A/D < 1, judged
    from the post time to the close.
  - SECTOR: the sector index close vs 0.3×ATR. FII / gap claims: NOT_SCORED in v1 (stored, not scored).
  - **TODO (follow-up, 2026-11-25 final review):** the night scores are stored on each row
    (`outcomes`) but nothing reads them yet — no per-channel information accuracy is built, and neither the
    judge's verifiedNotes nor its prompt cite one. Wiring the scores into the night review / channel
    accuracy is a separate follow-up ticket.
- **Owner**: an alert (via the existing owner-alert service) for MARKET-scope CONFIRMED claims with bias
  CAUTION/BEAR/BULL, at most one per channel per 30 min; and a "Market notes" list on the Telegram signals
  page showing each reading with its verdict and evidence.
- Existing `channel_infos` stays written by the rule extractor for back-compat; the judge prefers
  readings when present.

### 5.6 Storage

New table `message_readings` (one row per message, upsert on edit): `message_id` PK, `channel_id`,
`posted_at`, `read_at`, `status` (READ | FAILED | STALE | CACHED), `kind`, `scope`, `claims` jsonb,
`call` jsonb, `parse_agrees` bool null, `missed_by_rules` bool, `summary`, `model`, `packet` jsonb
(what the AI saw), latency columns, `error`. Indexes on (`posted_at`), (`scope`, `posted_at`).

### 5.7 Health (no silent absence)

- A 5-minute health check during market hours: if ≥ 3 posts arrived in the last 15 min and 0 readings
  were READ, raise an ops alert and show a red badge on the Telegram page.
- `/api/signal-intake/reader/health` returns last read time, 1h counts by status, p50/p95 latency.

### 5.8 Switch and rollout

`MESSAGE_READER=off | shadow | on` (default `off`).
- `shadow`: everything reads and stores; the judge does **not** see readings; UI shows them.
- `on`: judge sees `verifiedNotes`; owner alerts sent.
Plan: deploy after 15:35 IST in `shadow`, check one session (latency, verdict quality, failures).
`on` changes the live signal judge's packet (new judge prompt version), so before `on` the build includes
a **judge replay**: that session's signal calls judged with and without `verifiedNotes`, graded the same
way judge effort was tuned (memory: signal-judge-effort). `on` only if the with-notes run is not worse.
(2026-11-25 final review: both arms are re-judged fresh with the same model / effort, 3 runs each, majority
verdict; GO needs ≥ 20 graded decisions, pooled across shadow sessions if one is not enough.)

## 6. Decided by the owner

- Approach A; AI reads every message; token cost is not a constraint.
- Must be quick and read several messages at the same time.
- Decisions are taken on its output (§5.5 defines how, as context — see §7).
- Vertex capacity may be raised (owner 2026-11-25): `AGENTS_GLOBAL_CONCURRENCY` 16 → 24 so `signal.read`
  (8) adds capacity instead of taking it from parse / vision / news. Trading reserve stays 6.

**Meaning of a verdict.** CONFIRMED / CONTRADICTED = does **our data at the moment of the post** agree
with what the channel says is happening (present state), not the AI's forecast. Whether the channel's
forward-looking claim came true is scored separately by the night review (§5.5), which builds each
channel's information accuracy. The judge sees both: the verdict and the channel's accuracy record.

## 7. Calls made in this design (owner to check)

- Verdicts are **context for the judge, not a hard rule**; no order is blocked or placed by a verdict alone.
- Trade calls stay on the rule parser; the AI parse is **shadow** until it has a record.
- Model Sonnet 5.5, pool of 8, targets p50 15 s / p95 30 s.
- Posts > 30 min old at dequeue are not read.
- Rollout `shadow` first for one session, then a judge replay, then `on`.
- Verdict = present-state check (option (a)); proposed to the owner, not explicitly picked.
- Image posts are verified from the vision reader's stored output; no second image call.
- Night-review scoring rules for CAUTION / MARKET / breadth claims as in §5.5.

## 8. Left to the builder

Exact prompt wording; JSON schema file; which agent group hosts the pool; the packet's per-instrument
resolution for SENSEX/BSE and MCX names (note: the level book cannot build for SENSEX today — pass
`unavailable` with the reason, do not fail); migration; UI layout of the Market notes list; tests
(pool concurrency, packet time-box, evidence validation, health alert, judge packet contents).
