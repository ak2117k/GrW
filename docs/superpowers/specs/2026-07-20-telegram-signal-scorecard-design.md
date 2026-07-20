# Telegram Signal Scorecard — Design Spec

> **Status:** Draft for review
> **Date:** 2026-07-20
> **Scope:** Admin-only R&D feature. Read-only. No coupling to `trade-engine`.

---

## 1. Purpose

Ingest trade "signals" posted in third-party Telegram channels, parse them into
structured signals, auto-evaluate each one's outcome against real market data,
and surface a **per-channel scorecard** (win rate, average result, sample counts).

The goal is measurement, not execution: decide which Telegram channels are
actually worth anything **before** trusting or auto-trading any of them. There is
no order placement anywhere in this feature.

### Non-goals (this phase)

- No auto-trading / order placement.
- No per-user Telegram accounts — a single admin-curated account only.
- No vision/OCR of chart images — **text-only parsing** this phase (deferred to Phase 2).
- No honoring of a channel's own follow-up exit calls ("book partial", "SL to cost")
  — outcomes are evaluated **mechanically** against the signal's own levels. Deferred to Phase 2.

---

## 2. Context & Constraints

- **Multi-tenant platform**, but this feature is **admin-only, global** (single
  curated channel set, single Telegram account). No per-tenant scoping in the data model.
- **Prod-from-start**, but hosted **free for now** (local / free tier during R&D),
  designed as a **dedicated always-on worker** so it can move to a paid always-on
  worker later without code change.
- Follows platform principles from `CLAUDE.md`: safety-first (read-only here),
  audit everything (raw messages + event log retained), credential security
  (session encrypted at rest, never logged), resume-from-last-known-state after crash.

### Architectural precedent

This mirrors the existing **Chartink module** almost exactly
(`Scanner → Alert → AlertSetup` + `WatchEntry`/`WatchStatus` outcome tracking).
The only structural difference is the **entry point**: Chartink pushes structured
data to an inbound webhook; here a persistent Telegram listener pulls messages and
pushes them into an internal endpoint. Everything downstream of ingest reuses proven shapes.

---

## 3. Architecture

Two new components — a Python listener and a NestJS `telegram` module — over the
existing internal-callback pattern (`ml-trigger`).

```
┌─────────────────────────── ai-engine (Python) ───────────────────────────┐
│  telegram-listener  (NEW, standalone always-on runnable)                  │
│    • Telethon MTProto client, encrypted StringSession                     │
│    • @events.NewMessage(chats=WATCHED) → live stream                      │
│    • on startup/reconnect: get_messages(min_id=lastSeenMsgId) → backfill   │
│    • per message → LLM parser route → structured signal JSON               │
│    • POST → NestJS internal endpoint (ml-trigger-style shared-secret)      │
│                                                                           │
│  routes/telegram_parse.py  (NEW)                                          │
│    • text → strict JSON: {isSignal, symbol, side, instrument, strike,     │
│              expiry, entryMode, entryLow/High, slMode, stopLoss,           │
│              targets[], signalType, horizon, confidence}                   │
└───────────────────────────────────┬───────────────────────────────────────┘
                                     │  internal POST (shared secret header)
                                     ▼
┌─────────────────────────── apps/api (NestJS) ─── modules/telegram/ ───────┐
│  controllers/telegram-ingest.controller.ts   @Public + shared-secret      │
│  controllers/telegram.controller.ts          @Roles(admin) — read API     │
│  services/telegram-ingest.service.ts         dedup + persist + enqueue     │
│  services/telegram-signal.service.ts         create tracked signal         │
│  services/telegram-tracker.service.ts        outcome evaluation            │
│  services/telegram-stats.service.ts          per-channel win-rate rollups  │
│  workers/telegram-track.processor.ts         Bull: evaluate PENDING/ACTIVE │
│  repositories/telegram.repository.ts                                       │
│  gateways/telegram.gateway.ts                admin live updates            │
└───────────────────────────────────┬───────────────────────────────────────┘
                                     ▼
        PostgreSQL  +  Bull queue 'telegram-track'  +  MarketFeed / historical (reused)
                                     ▼
        apps/web  →  admin-only "Telegram Signals" section
```

### Component responsibilities (single-purpose units)

| Component | Does | Depends on |
|---|---|---|
| `telegram-listener` (Py) | Hold socket, receive/backfill, call parser, forward | Telethon, session store, ingest URL |
| `telegram_parse.py` (Py) | Free text → structured signal JSON | LLM stack |
| `telegram-ingest.controller` | Auth + accept forwarded signals | shared secret |
| `telegram-ingest.service` | Dedup, persist raw + parsed, enqueue tracking | repo, Bull |
| `telegram-signal.service` | Resolve token, create `TelegramSignal` | `instrument.service` |
| `telegram-tracker` + `track.processor` | Evaluate outcome → status + `resultPct` | MarketFeed / historical (reused) |
| `telegram-stats.service` | Per-channel win-rate aggregation | repo |
| `telegram.controller` + gateway + web | Admin-only read UI + live updates | RolesGuard |

**Read-only isolation:** the module never imports `trade-engine`. Order placement
is structurally impossible, satisfying the platform's paper/safety-first rule for free.

---

## 4. The Watch Mechanism (how we keep watch)

Push, not poll — the same architectural shape as `MarketFeedService`, for chat
messages instead of ticks.

1. **One-time login → reusable session.** Listener logs in once (phone + OTP);
   Telethon returns a `StringSession` stored **encrypted at rest**. Restarts reuse it.
2. **Membership is the subscription.** The account joins each watched channel once
   (public `@username` or private invite link). Telegram then folds that channel's
   activity into the account's update stream automatically.
3. **One persistent socket, pushed.** `client.run_until_disconnected()` holds the
   connection; `@events.NewMessage(chats=WATCHED)` fires per message in sub-second
   real-time. `chats=` filters to the curated list.
4. **Gap backfill.** The socket does not replay messages missed while the process
   was down. We persist `lastSeenMsgId` per channel; on every (re)connect the
   listener calls `get_messages(channel, min_id=lastSeenMsgId)` to pull the gap,
   replays through the same pipeline (idempotent via the unique key), then advances
   the pointer. Telethon auto-reconnects across brief network blips on its own.

---

## 5. Data Model (Prisma)

Three-tier `Channel → Message → Signal` (mirrors `Scanner → Alert → AlertSetup`),
plus a `WatchEntry`-style outcome folded into the signal, plus an audit event log.

```prisma
model TelegramChannel {
  id               String            @id @default(cuid())
  tgChannelId      String            @unique   // Telegram numeric id, stored as string (bigint-safe)
  username         String?                     // @handle for public channels
  title            String
  inviteLink       String?                     // for private channels
  isActive         Boolean           @default(true)
  lastSeenMsgId    Int               @default(0)   // gap-backfill pointer
  joinedAt         DateTime?
  addedAt          DateTime          @default(now())
  messages         TelegramMessage[]
  signals          TelegramSignal[]
  @@map("telegram_channels")
}

model TelegramMessage {
  id           String           @id @default(cuid())
  channelId    String
  channel      TelegramChannel  @relation(fields: [channelId], references: [id])
  tgMessageId  Int                                // Telegram per-channel monotonic id
  rawText      String
  postedAt     DateTime                           // message.date
  receivedAt   DateTime         @default(now())
  parseStatus  String                             // 'signal' | 'not-signal' | 'low-confidence' | 'error'
  rawPayload   Json                               // full parser output + msg metadata
  signal       TelegramSignal?
  @@unique([channelId, tgMessageId])              // dedup key → idempotent ingest + backfill
  @@index([channelId, postedAt])
  @@map("telegram_messages")
}

model TelegramSignal {
  id             String                @id @default(cuid())
  messageId      String                @unique
  message        TelegramMessage       @relation(fields: [messageId], references: [id])
  channelId      String                              // denormalized → fast per-channel stats
  channel        TelegramChannel       @relation(fields: [channelId], references: [id])

  // ---- parsed fields ----
  symbol         String
  token          String?                             // resolved via instrument.service (null = untrackable)
  exchange       String?                             // NSE | NFO | MCX
  instrument     String                              // 'EQUITY' | 'OPTION' | 'FUTURE' | 'INDEX'
  side           String                              // 'LONG' | 'SHORT'
  optionType     String?                             // 'CE' | 'PE'
  strike         Float?
  expiry         DateTime?
  signalType     String                              // 'LEVELED' | 'DIRECTIONAL'
  entryMode      String                              // 'CMP' | 'ZONE' | 'TRIGGER_ABOVE' | 'TRIGGER_BELOW' | 'NEAR'
  entryLow       Float?
  entryHigh      Float?
  slMode         String                              // 'NUMERIC' | 'PREMIUM_PAID' | 'NONE'
  stopLoss       Float?                              // null unless slMode = NUMERIC
  targets        Float[]                             // T1, T2, T3…
  horizon        String                              // 'INTRADAY' | 'SWING'
  parseConfidence Float                              // 0..1

  // ---- outcome tracking ----
  status         TelegramSignalStatus  @default(PENDING)
  entryPrice     Float?                              // resolved fill price (synthetic post-time price for DIRECTIONAL)
  entryFilledAt  DateTime?
  exitPrice      Float?
  exitAt         DateTime?
  hitTargetIndex Int?                                // which target reached (0 = T1)
  resultPct      Float?                              // signed % result
  trackExpiresAt DateTime?
  createdAt      DateTime              @default(now())
  events         TelegramSignalEvent[]
  @@index([channelId, status])
  @@index([token, status])
  @@map("telegram_signals")
}

model TelegramSignalEvent {
  id         String          @id @default(cuid())
  signalId   String
  signal     TelegramSignal  @relation(fields: [signalId], references: [id])
  type       String          // 'PARSED' | 'ENTRY_FILLED' | 'TARGET_HIT' | 'SL_HIT' | 'EXPIRED' | 'UNTRACKABLE'
  price      Float?
  note       String?
  at         DateTime        @default(now())
  @@index([signalId])
  @@map("telegram_signal_events")
}

enum TelegramSignalStatus {
  PENDING       // parsed, waiting for entry to be touched
  ACTIVE        // entry filled, watching SL/target
  TARGET_HIT    // ≥ T1 (or forward-return target) reached → WIN
  SL_HIT        // stop / forward-return stop hit → LOSS
  EXPIRED       // neither within window → neither win nor loss
  UNTRACKABLE   // couldn't resolve token / insufficient data
  INVALIDATED   // bad parse, admin-dismissed
}
```

**Stats are computed on read**, not stored — outcomes resolve asynchronously, so a
denormalized win/loss counter would drift. A `GROUP BY channelId` over the indexed
column is cheap at R&D volume. (Contrast: Chartink denormalizes `fireCount`, which
is safe because it only ever increments.)

---

## 6. Parsing Contract (ai-engine)

`telegram_parse.py` returns **strict JSON via forced structured output**. Example
(from a real sample, `CRUDEOIL 9500 CE / NEAR 225 / TARGET 240/260/300 / SL PAID`):

```json
{
  "isSignal": true,
  "symbol": "CRUDEOIL", "instrument": "OPTION", "exchange": "MCX", "side": "LONG",
  "optionType": "CE", "strike": 9500, "expiry": null,
  "signalType": "LEVELED", "entryMode": "NEAR", "entryLow": 225, "entryHigh": 225,
  "slMode": "PREMIUM_PAID", "stopLoss": null, "targets": [240, 260, 300],
  "horizon": "INTRADAY", "confidence": 0.9
}
```

Three jobs:

1. **Classify `isSignal`** — reject chatter, greetings, GIFs, P&L screenshots, ads,
   pinned disclaimers. Non-signals stored (`parseStatus='not-signal'`), never tracked.
2. **Normalize varied formats** — entry ranges vs single vs "buy at CMP" vs breakout
   trigger ("ABOVE 130"); multiple targets; **non-numeric SL** (`"PAID"` → `PREMIUM_PAID`,
   "no SL" → `NONE`); emoji noise. Unfillable fields → `null`.
3. **Emit `confidence`, `signalType`, `horizon`** — below a confidence threshold →
   `parseStatus='low-confidence'`, stored but not tracked. `signalType` distinguishes
   LEVELED (numeric levels present) from DIRECTIONAL (symbol + thesis only). `horizon`
   sets the tracking window.

**Instrument type is parsed per message, never inferred from the channel** — one
channel mixes NSE stock options, MCX commodity options, and index options.

### Parser golden-set (real sample fixtures)

| Sample | Expected |
|---|---|
| `Sgmart — perfect breakout continuation pattern…` | DIRECTIONAL, EQUITY, LONG, no levels, `signalType=DIRECTIONAL` |
| `#TORNTPHARM 4850 CE ABOVE 130 #STOCK_OPTIONS #JUL` | LEVELED, OPTION/CE, strike 4850, expiry JUL, `entryMode=TRIGGER_ABOVE` entry 130, SL/targets null |
| `BUY CRUDEOIL 9500 CE / NEAR 225 / TARGET 240/260/300 / STOPLOSS PAID` | LEVELED, OPTION/CE, strike 9500, MCX, entry ~225, targets [240,260,300], `slMode=PREMIUM_PAID` |

---

## 7. Symbol → Token Resolution — ⚠️ Known Hazard

A parsed symbol must resolve to a tradeable token via `instrument.service` before
tracking. Unresolved → `UNTRACKABLE`.

**Hard dependency / linked risk — `instrument-master-refresh-dead`:** `refreshMaster()`
is currently never called, so the `instruments` table is an incomplete de-facto
allowlist (Chartink already rejects valid-but-unlisted symbols like NEOGEN). Telegram
names mid/small-caps and fresh listings constantly, so this will inflate the
`UNTRACKABLE` rate and distort scorecards. **Prerequisite:** fix instrument-master
refresh (or confirm resolution path covers Angel's in-memory master). Verify current
state of `refreshMaster()` at implementation time.

Options add: resolve option token from underlying + strike + expiry + CE/PE (via
`instrument.service` / `options-chain`). Unstated expiry → infer nearest weekly.
Unresolvable / expired contract → `UNTRACKABLE`.

---

## 8. Outcome Evaluation

### State machine

```
PENDING ──entry touched──▶ ACTIVE ──target hit──▶ TARGET_HIT (win)
   │  (CMP/DIRECTIONAL →     │
   │   ACTIVE immediately)   ├──SL hit──────────▶ SL_HIT (loss)
   │                         │
   └──unfilled by expiry──▶ EXPIRED   └──expiry, neither──▶ EXPIRED
```

### LEVELED signals (numeric levels present)

- **Entry fill:** `PENDING` waits for price to touch the entry zone/trigger.
  "Buy at CMP" fills immediately at post-time price.
- **Intrabar detection** via candle high/low: LONG target if `high ≥ target`,
  SL if `low ≤ SL` (inverse for SHORT).
- **Tie-break:** if one candle touches **both** SL and target, assume **SL first**
  (conservative — never inflate win rate).
- **`slMode=PREMIUM_PAID` / `NONE`** (options-buying, no hard stop): win if any
  target hits before expiry; otherwise result = value at expiry (typically full
  premium loss). No `SL_HIT` path.
- **`resultPct`** = signed `(exit − entry)/entry` (× −1 for SHORT); for options,
  computed on the option premium.

### DIRECTIONAL signals (no numeric levels)

- **Synthetic entry** = price at post time (`entryMode=CMP`, filled immediately).
- **Forward-return thresholds** (configurable defaults): WIN if price moves **+X%**
  before **−Y%** within the horizon; LOSS if −Y% first; else `EXPIRED`.
  Defaults: INTRADAY +3% / −2%, SWING +8% / −5% (configurable in settings).

### Track windows

INTRADAY expires EOD; SWING expires after N configurable days (`trackExpiresAt`).

### Evaluation modes

- **Live (forward):** window is present/future → subscribe token via `MarketFeed`
  (respect ~50-token rotation). Fine at R&D volume.
- **Historical (one-shot):** entire window already past (backfilled signals) →
  resolve directly from historical candles in one pass, no polling.
  ⚠️ **Known hazard — `historical-cache-window-hazard`:** `getHistoricalData` caches
  ignoring `[from, to]`, so an odd window returns truncated data **and** poisons the
  live trailing-stop cache. The tracker MUST use a **window-safe historical read**
  (or the fix must land first). Verify cache behavior at implementation time.

---

## 9. Win-Rate Metric (defined, no ambiguity)

Per channel, computed on read:

- **Win rate** = `TARGET_HIT / (TARGET_HIT + SL_HIT)` — **resolved signals only**.
- `EXPIRED` and `UNTRACKABLE` are **excluded from the ratio** but shown as separate counts.
- Also surfaced: total signals, avg `resultPct`, best/worst, `UNTRACKABLE` %
  (a parse-quality signal), median time-to-target, LEVELED-vs-DIRECTIONAL split.
- **Minimum-sample-size guard** on the leaderboard — a 1-for-1 channel is not "100%".

Three deliberate pessimisms keep the scorecard honest: SL-first tie-break,
min-sample guard, and excluding EXPIRED/UNTRACKABLE from the ratio (while still showing them).

---

## 10. Admin UI — "Telegram Signals" section (`@Roles(admin)`)

| View | Shows |
|---|---|
| **Channels** | Watched channels; add/remove (join/leave), toggle active; row = scorecard (win rate, # signals, avg %, untrackable %, leveled/directional split) |
| **Signals feed** | Parsed signals with status badges; filter by channel/status/type; links to raw message |
| **Leaderboard** | Channels ranked by win rate with min-sample guard |
| **Message inspector** | Raw text ↔ parse result side-by-side — parser-tuning tool |

Live updates via the existing admin WebSocket gateway pattern
(`authenticate-admin-socket.ts`). No view renders anything from `trade-engine`.

---

## 11. Security

- **Telethon session** (`api_id`/`api_hash` + `StringSession`) encrypted at rest via
  the same mechanism as `broker_credentials` / TDA-004 secrets transport. Never logged.
- **Internal ingest endpoint**: `@Public` + shared-secret header, constant-time
  compare, secret redacted from logs (clone of `ml-trigger` / Chartink webhook auth).
- **Admin read API + gateway**: `@Roles(admin)` + admin-socket auth.
- **Read-only isolation**: no `trade-engine` import.
- **FloodWait**: joining many channels trips Telegram limits; join flow honors
  Telethon flood-wait backoff.

---

## 12. Resilience (resume-from-last-known-state)

- **Reconnect + backfill** via `lastSeenMsgId` (Section 4), idempotent through
  `@@unique([channelId, tgMessageId])`.
- **Parser failure** → message stored `parseStatus='error'`; listener never crashes on one bad message.
- **Ingest idempotency** → duplicate `(channelId, tgMessageId)` is a no-op.
- **Tracker** → window-safe historical reads, feed-slot limits respected, option
  resolution failures marked `UNTRACKABLE` with an event (never silently dropped).

---

## 13. Testing

- **Parser golden-set** (Section 6 fixtures) — the three real samples become the
  regression suite; assert exact structured output.
- **Ingest**: dedup/idempotency, channel upsert, enqueue.
- **Tracker**: intrabar target/SL detection, SL-first tie-break, DIRECTIONAL
  forward-return thresholds, `PREMIUM_PAID` evaluation, `EXPIRED`.
- **Stats**: win-rate math excludes EXPIRED/UNTRACKABLE; min-sample guard.
- **Controllers**: admin RBAC + internal-secret auth (following `tdaXXX` test-dir convention).

---

## 14. Deployment

- Listener is a **standalone runnable** — host-agnostic. Run free during R&D
  (local / free tier); promote to a **dedicated always-on worker** (e.g. Render
  Background Worker) for prod without code change.
- New Bull queue `telegram-track` registered in the NestJS module.
- New env: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION` (encrypted),
  `TELEGRAM_INGEST_SECRET`, `TELEGRAM_INGEST_URL`, forward-return threshold config.

---

## 15. Open Questions / Prerequisites

1. **`instrument-master-refresh-dead`** (Section 7) — fix or confirm resolution path
   before scorecards are trustworthy.
2. **`historical-cache-window-hazard`** (Section 8) — window-safe historical read
   required for backfilled-signal evaluation.
3. Confidence threshold value for `low-confidence` gating — tune against real volume.
4. Forward-return default thresholds — validate against a sample of directional channels.

---

## 16. Phasing

- **Phase 1 (this spec):** text-only parsing, LEVELED + DIRECTIONAL tracking,
  admin scorecard. Prerequisites #1–2 addressed.
- **Phase 2 (future):** vision/OCR of chart images; honoring channel follow-up exit
  calls; per-user channels; possible promotion of high-scoring channels into the
  live signal pipeline (explicitly out of scope now).
