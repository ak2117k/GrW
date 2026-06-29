# Chartink Webhook Integration — Design Spec

**Date:** 2026-05-06
**Status:** Approved (user picked the recommended option at every clarifying question)
**Author:** Brainstorm session with Claude (Opus 4.7)

---

## Goal

Ingest Chartink scanner alerts via webhook, run each hit through our existing setup pipeline (`SignalGeneratorService.analyze`), and surface the resulting locked setups on the existing /signals page (badged with the originating scanner) plus a new dedicated /chartink page for scanner state, alert history, and per-symbol decisions.

The user authors and maintains scanners on chartink.com as today; our system becomes a downstream consumer that turns Chartink hits into actionable trade plans (entry/SL/TP1-at-obstacle/option strike) using the same gates that govern cron-fired setups.

## Non-goals

- Re-implementing Chartink's DSL or scanner logic locally. Scanners stay on Chartink.
- Auto-trade on Chartink alerts. Setups become *visible* and *trackable* but the user still triggers execution. Auto-trade-on-alert is explicitly deferred — we want to first learn how often Chartink hits agree with our reject-gate stack.
- A polling-based fallback if webhooks fail or the user is on a non-premium tier. The design assumes Chartink's "Webhook URL" alert option is available (Premium tier).
- Customizing the Chartink webhook payload. Chartink's payload is fixed at 7 fields with no extensibility — we accept what they send.
- Authenticating Chartink itself (HMAC, signed payload). Chartink doesn't sign — we authenticate the *URL* via a secret embedded in the path.

---

## Why this design

The user's existing workflow is: write/maintain scanners on chartink.com, look at hits manually, decide whether to trade. The bottleneck is the manual translation step — Chartink tells you *which* symbols matched, but not *whether the setup is tradeable* in our framework (correct distance from PDH/PDL, regime-aligned, MTF-aligned, grade ≥ B, options-strike with positive expected P&L).

Our existing pipeline already produces all of those outputs for cron-fired setups. The cheapest way to get the same output for Chartink-sourced candidates is to feed them into the same pipeline. That's all this integration does.

The "dedicated page + /signals badge" UI split exists because Chartink alerts have two distinct uses:

1. **Action**: a tradeable setup card with entry/SL/TP/option strike. Belongs on /signals where the user already looks.
2. **Diagnostic**: which Chartink hits did our gates accept vs. reject, and *why*. Useful when tuning scanners on the Chartink side. Has no good home on /signals; gets its own page.

---

## Architecture

```
                         ┌────────────────────────────────┐
   chartink.com ─POST──► │ ChartinkWebhookController       │
                         │   POST /webhooks/chartink/:secret│
                         └──────────────┬──────────────────┘
                                        │
                                        ▼
                         ┌────────────────────────────────┐
                         │ ChartinkIngestService           │
                         │   - validate DTO                │
                         │   - upsert ChartinkScanner      │
                         │   - persist ChartinkAlert       │
                         │   - enqueue chartink-process job│
                         └──────────────┬──────────────────┘
                                        │ Bull queue
                                        ▼
                         ┌────────────────────────────────┐
                         │ ChartinkProcessWorker           │
                         │   per (symbol, hitPrice):       │
                         │     1. resolve token            │
                         │     2. analyze()                │
                         │     3. persist ChartinkAlertSetup│
                         └──────────────┬──────────────────┘
                                        │
                                        ▼
                         ┌────────────────────────────────┐
                         │ Existing setup-tracker locks    │
                         │ a setup (when grade ≥ B). The   │
                         │ existing /signals listing reads │
                         │ from the locked-setups store →  │
                         │ Chartink-sourced setups appear  │
                         │ alongside cron-fired ones, with │
                         │ a chartinkSource badge.          │
                         └────────────────────────────────┘

                         ┌────────────────────────────────┐
                         │ ChartinkController (REST)       │
                         │   GET /api/chartink/scanners    │
                         │   GET /api/chartink/alerts      │
                         │   GET /api/chartink/alerts/:id  │
                         └──────────────┬──────────────────┘
                                        │
                                        ▼
                         ┌────────────────────────────────┐
                         │ /chartink page (frontend)       │
                         │   - scanner list with fire counts│
                         │   - recent alert history         │
                         │   - per-alert decision breakdown │
                         └────────────────────────────────┘
```

**Component responsibilities:**

| Component | Responsibility |
|---|---|
| `ChartinkWebhookController` | Authenticate via `:secret` URL segment, validate body shape, hand to `ChartinkIngestService`, return 200 fast (<100ms target). |
| `ChartinkIngestService` | Parse the CSV `stocks` and `trigger_prices` strings, derive a real `triggeredAt: Date` from the clock-only `triggered_at` field plus today's IST date, upsert the `ChartinkScanner`, insert the `ChartinkAlert`, and enqueue a `chartink-process` job. |
| `ChartinkProcessWorker` | Consume the queue, one job per alert. For each (symbol, hitPrice) pair: resolve token, run `signalGeneratorService.analyze`, persist a `ChartinkAlertSetup` row. |
| `ChartinkProcessService` | Pure business logic invoked by the worker — separated for testability (worker is a thin Bull adapter). |
| `ChartinkRepository` | Prisma access for the three new tables. Single class, three methods (`upsertScanner`, `createAlert`, `createAlertSetup`) plus listing reads for the controller. |
| `ChartinkController` | REST reads for the /chartink frontend. No mutations. |
| Frontend `/chartink` page | List scanners + alert history + per-alert decision breakdown. Pure read. |
| Frontend `SignalCard` badge | One small component change — when `signal.chartinkSource` is set, show a `📊 Chartink: {scannerName}` chip. |

---

## Webhook contract

**Endpoint:** `POST /webhooks/chartink/:secret`

The `:secret` segment is a long random token (≥ 32 chars URL-safe-base64) generated once and stored in `.env` as `CHARTINK_WEBHOOK_SECRET`. The controller compares the URL segment against the env value with `crypto.timingSafeEqual` to avoid timing-leak side-channels. Mismatch → `401`, no body.

**Request body** (validated against `ChartinkWebhookDto`):

```typescript
class ChartinkWebhookDto {
  @IsString() @IsNotEmpty() stocks: string;          // CSV: "RELIANCE,INFY,TCS"
  @IsString() @IsNotEmpty() trigger_prices: string;  // CSV: "1467.4,1612.0,3890.5", parallel-indexed
  @IsString() @IsNotEmpty() triggered_at: string;    // clock only: "2:34 pm" — no date, no TZ
  @IsString() @IsNotEmpty() scan_name: string;       // human label: "Short term breakouts"
  @IsString() @IsNotEmpty() scan_url: string;        // slug: "short-term-breakouts" — natural key
  @IsString() @IsNotEmpty() alert_name: string;
  @IsString() webhook_url: string;                   // Chartink echoes back; we ignore
}
```

The CSV parsing splits on `,`, trims whitespace, and zips the two parallel arrays into `{ symbol, hitPrice }` pairs. Length mismatch → reject the whole alert with a logged warning (Chartink should never send mismatched lengths, so this is a defensive guard).

The `triggered_at` clock string is interpreted as today's IST date. We do NOT trust it for ordering — we use `receivedAt` for that. The `triggeredAt` field on `ChartinkAlert` exists for display ("alert says 2:34 pm; we processed at 2:34:08 pm") so the user can spot if their webhook URL is mis-configured (alert clock far from receive time).

**Response:** `200 { received: true }` once the alert is persisted and the queue job is enqueued. Synchronously waits for both DB writes; does NOT wait for processing.

---

## Schema (Prisma)

Three new tables. No changes to existing models.

```prisma
model ChartinkScanner {
  id           String   @id @default(cuid())
  scanUrl      String   @unique
  scanName     String
  alertName    String?
  firstSeenAt  DateTime @default(now())
  lastFiredAt  DateTime?
  fireCount    Int      @default(0)
  alerts       ChartinkAlert[]
  @@map("chartink_scanners")
}

model ChartinkAlert {
  id           String   @id @default(cuid())
  scannerId    String
  scanner      ChartinkScanner @relation(fields: [scannerId], references: [id])
  triggeredAt  DateTime  // derived: today's IST date + clock string from payload
  receivedAt   DateTime  @default(now())
  rawPayload   Json      // verbatim Chartink body — debugging
  setups       ChartinkAlertSetup[]
  @@index([scannerId, triggeredAt])
  @@map("chartink_alerts")
}

model ChartinkAlertSetup {
  id            String   @id @default(cuid())
  alertId       String
  alert         ChartinkAlert @relation(fields: [alertId], references: [id])
  symbol        String
  token         String?         // null when kind='unresolved'
  hitPrice      Float
  kind          String          // 'setup' | 'no-setup' | 'unresolved' | 'error'
  setupId       String?         // FK-ish to existing Setup model when kind='setup'
  rejectReason  String?         // populated when kind='no-setup' or 'error'
  processedAt   DateTime @default(now())
  @@index([alertId])
  @@index([token])
  @@map("chartink_alert_setups")
}
```

`ChartinkAlertSetup.setupId` is intentionally not a Prisma `@relation` to the `Setup` model — keeping it loose so the existing setup lifecycle (close, invalidate, etc.) doesn't cascade-delete or constrain Chartink history. Joins are done in application code when surfacing the badge on /signals.

---

## Processing algorithm

`ChartinkProcessWorker` consumes one `chartink-process` job. Each job carries `{ alertId }`. The worker loads the alert + its parsed `(symbol, hitPrice)` pairs, then for each pair:

```
1. Resolve symbol → token:
     instrument = marketDataRepository.getInstrumentBySymbol(symbol, 'NSE')
     IF instrument is null:
       persist ChartinkAlertSetup { kind: 'unresolved', rejectReason: 'symbol not in local DB' }
       continue

2. Run analysis:
     result = await signalGeneratorService.analyze(
       instrument.token, 'NSE', symbol, '15m'
     )

3. Persist outcome:
     IF result.kind === 'setup':
       // analyze() has already locked the setup via setup-tracker.
       // Find the locked setup id by token + recent timestamp.
       lockedSetup = setupTracker.getActive(instrument.token)
       persist ChartinkAlertSetup {
         kind: 'setup', token, hitPrice, setupId: lockedSetup?.id
       }
     ELSE: // result.kind === 'no-setup'
       persist ChartinkAlertSetup {
         kind: 'no-setup', token, hitPrice, rejectReason: result.reason
       }

4. Sleep 350ms (Angel One historical-API rate-limit pattern, per memory)
```

Errors thrown by `analyze()` (broker timeout, instrument lookup failure) → caught, persist `kind: 'error'` with the error message in `rejectReason`. Worker continues with the next symbol. The job itself succeeds as long as ≥ 1 symbol was attempted.

The worker uses Bull's default retry (3 attempts with exponential backoff) for the job-level failure case (e.g., DB unreachable at job start). Per-symbol failures don't trigger job retry — they're persisted as `kind: 'error'` rows.

---

## Frontend surfaces

### `/chartink` page (new)

Three sections stacked vertically:

1. **Scanners** — table of `ChartinkScanner` rows. Columns: scanName, scanUrl (linked to chartink.com), fireCount, lastFiredAt. Sort by `lastFiredAt desc`.
2. **Recent alerts** — last 50 `ChartinkAlert` rows, newest first. Columns: scanner, triggeredAt vs receivedAt (delta in seconds), # symbols, breakdown of kinds (e.g. `5 setups · 2 no-setup · 0 unresolved`).
3. **Selected alert detail** — when a row in (2) is clicked, expand below to show every `ChartinkAlertSetup`: symbol, hitPrice, kind, link to the setup card if `kind='setup'`, rejectReason if not.

No write actions on this page — diagnostic only. Polling: refresh on a 30-second timer.

### `SignalCard` badge

When a signal's underlying setup has an associated `ChartinkAlertSetup` row, render a small chip below the existing grade chip:

```
📊 Chartink: {scannerName}
```

Click the chip → navigate to the `/chartink` page with the corresponding alert pre-selected. Implementation: extend the signal API response with optional `chartinkSource: { scannerName, alertId } | null`. Backend joins on `Setup.id = ChartinkAlertSetup.setupId`.

---

## Edge cases

| Case | Behavior |
|---|---|
| Webhook auth fails (wrong / missing `:secret`) | `401`, no body, no DB insert. Logged at warn level with the source IP. |
| Body fails DTO validation | `400`, no DB insert. Raw payload logged at warn level for debugging Chartink config issues. |
| `stocks` and `trigger_prices` CSVs have different lengths | Reject the whole alert with `400` and log a warning. Should never happen but the parser is defensive. |
| Same scanner fires twice in 60s | Two separate `ChartinkAlert` rows; both processed independently. The setup-tracker's existing "one active setup per token" rule prevents double-locking when the second alert tries to re-fire on a still-active setup. |
| Symbol present in alert but not in our `instrument` table | `kind='unresolved'`, `rejectReason='symbol not in local DB'`. Visible on the /chartink debug view. v1 does NOT auto-fetch from Angel One searchScrip to add — follow-up if this is frequent. |
| Symbol resolves but token is stale (e.g., MCX FUTCOM rolled) | `analyze()` returns `'no-setup'` with the broker-empty reject reason. Stored as `kind='no-setup'`. Once the commodity-roll cron lands (separate spec), this case self-heals. |
| Alert arrives outside market hours (pre-open / post-close) | `analyze()` returns `'no-setup'` with `reject:outside-window`. Stored as `kind='no-setup'`. No setup card; visible on /chartink. |
| Worker queue backs up (e.g. broker rate-limited) | Alerts continue queuing; processing latency grows. The `receivedAt - triggeredAt` lag on the /chartink page surfaces this so the user can act. |
| Worker process crashes mid-job | Bull retries with exponential backoff. Worst case: an alert is processed twice → duplicate `ChartinkAlertSetup` rows (acceptable, append-only). |
| Chartink fires after market close (e.g. EOD scanner) | Same as "outside market hours" above — stored as no-setup, visible for diagnostic. |
| `webhook_url` field in payload doesn't match our actual URL | Ignored. The field is Chartink echoing back its own config; we don't validate against it. |
| Chartink sends a duplicate webhook (network retry) | Two `ChartinkAlert` rows. Considered acceptable for v1 — the dedupe overhead isn't worth it given Chartink doesn't document explicit idempotency keys. Follow-up if it becomes noisy. |

---

## Test plan

### Backend unit tests

| File | What's covered |
|---|---|
| `chartink-ingest.service.spec.ts` | CSV parsing (happy path, mismatched lengths, whitespace, single symbol, empty), `triggered_at` IST date derivation (clock-only string → today's IST date), scanner upsert, alert insertion, queue enqueue. |
| `chartink-process.service.spec.ts` | Per-symbol routing — `setup` / `no-setup` / `unresolved` / `error` paths, mocking `signalGeneratorService.analyze` with each return shape. |
| `chartink-webhook.controller.spec.ts` | Auth (correct secret → 200, wrong → 401, missing → 401), DTO validation (missing fields → 400, malformed CSV → 400), happy path returns `{ received: true }` and triggers the ingest service exactly once. |

### Backend integration test

| File | What's covered |
|---|---|
| `chartink.e2e-spec.ts` | End-to-end: `POST /webhooks/chartink/:secret` with a synthetic 3-symbol Chartink payload → assert: `ChartinkAlert` row exists with the right `triggeredAt`, `ChartinkAlertSetup` rows for each symbol with the expected `kind` (mock `analyze()` to return one `setup`, one `no-setup`, one throws → `error`). |

### Frontend smoke

The `/chartink` page is read-only and renders fixtures cleanly. No automated test required for v1; visual smoke check covers it.

---

## Out of scope (explicit)

- **Auto-trade on Chartink alerts** — setups become visible and trackable; execution still requires user action. Revisit once we observe the agreement rate between Chartink hits and our reject gates over a week of real alerts.
- **Polling fallback** when webhooks fail or are unavailable. Premium tier is assumed.
- **Customizing Chartink's outbound payload** — Chartink doesn't support custom fields; we accept what they send.
- **Symbol auto-discovery via Angel One searchScrip** when a Chartink hit isn't in our `instrument` table. v1 marks unresolved + logs; we'll add searchScrip-on-miss only if it turns out to be common.
- **Webhook idempotency / dedupe** beyond what comes naturally from append-only storage. Two identical webhooks → two rows. Acceptable for v1.
- **Chartink scanner authoring from inside our app**. Scanners stay on chartink.com.
- **Multi-tenant** — single shared `CHARTINK_WEBHOOK_SECRET` per deployment. No per-user webhooks.

---

## Roll-out

- Single Prisma migration adds the three tables. No changes to existing schema.
- `CHARTINK_WEBHOOK_SECRET` env var must be set before the controller boots. Boot fails fast if it's missing — we'd rather not silently accept any caller.
- The new module is opt-in via standard NestJS module import; not active until `CHARTINK_WEBHOOK_SECRET` is provided. Deployment can roll without configuring Chartink first.
- After deploy, user generates the secret, sets it in `.env`, configures their Chartink scanners' "Webhook URL" alert action to `https://<our-domain>/webhooks/chartink/<secret>`. First webhook fire end-to-ends the integration.
- Reversion: revert the module + migration. The three new tables are independent of existing models — no data loss to existing flows.
