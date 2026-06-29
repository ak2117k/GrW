# Anand Dual-Track Signal Pages — Design Spec

**Date:** 2026-06-03
**Status:** Approved

---

## 1. Overview

When the "Anand Swing" Chartink scanner fires a webhook, the platform currently routes it through the gated/ungated Watch pipeline. This feature adds a **parallel dual-track analysis layer** — every Anand Swing alert auto-creates an entry in two new tables simultaneously:

- **Intraday track** — 5% profit target / 5% stop loss, expires at market close (15:15 IST)
- **Swing track** — 10% profit target / 10% stop loss, holds overnight until one is hit

Neither track places real or paper trades. They are pure analysis logs — tracking what _would have_ happened and displaying which of the 10 scoring factors the signal satisfied at entry time.

Two dedicated pages expose each track: `/intraday` and `/swing`.

---

## 2. Scanner Categorisation

`ChartinkScanner` gets one new field:

```
category  String  @default("OTHER")   // "ANAND_SWING" | "OTHER"
```

A scanner is tagged `ANAND_SWING` via a one-time `PATCH /api/anand/scanners/:id/category` call. All future webhooks from that scanner auto-feed both tracks. Existing scanners default to `OTHER` and are unaffected.

---

## 3. Database Schema

### 3.1 `IntradayEntry`

```prisma
model IntradayEntry {
  id             String    @id @default(cuid())
  symbol         String
  token          String?
  entryPrice     Float
  enteredAt      DateTime  @default(now())
  targetPct      Float     @default(5.0)
  stopPct        Float     @default(5.0)
  status         String    @default("WATCHING")
  // WATCHING | TARGET_HIT | STOPPED | EXPIRED
  exitPrice      Float?
  exitedAt       DateTime?
  alertId        String    // loose ref to ChartinkAlert.id — no Prisma @relation
  scoreBreakdown Json?     // 10-factor snapshot captured at entry time

  @@index([status, enteredAt])
  @@map("intraday_entries")
}
```

### 3.2 `SwingEntry`

```prisma
model SwingEntry {
  id             String    @id @default(cuid())
  symbol         String
  token          String?
  entryPrice     Float
  enteredAt      DateTime  @default(now())
  targetPct      Float     @default(10.0)
  stopPct        Float     @default(10.0)
  status         String    @default("WATCHING")
  // WATCHING | TARGET_HIT | STOPPED
  exitPrice      Float?
  exitedAt       DateTime?
  alertId        String
  scoreBreakdown Json?

  @@index([status, enteredAt])
  @@map("swing_entries")
}
```

No `@relation` on `alertId` in either model — intentionally loose, same pattern as `ChartinkAlertSetup.setupId`. This prevents Chartink alert lifecycle events (delete, cascade) from affecting these analysis logs.

---

## 4. Backend Architecture

### 4.1 Module Structure

```
modules/anand-dual-track/
├── anand-dual-track.module.ts
├── services/
│   ├── anand-dual-track.service.ts       # entry creation on webhook
│   └── anand-price-monitor.service.ts    # live price → status updates
├── repositories/
│   └── anand-dual-track.repository.ts    # DB access for both tables
└── controllers/
    └── anand-dual-track.controller.ts    # REST endpoints
```

### 4.2 Webhook Flow

```
ChartinkProcessService.processOne()
  │
  ├─ [existing] gated WatchService
  ├─ [existing] ungated UngatedWatchService
  │
  └─ [new] if scanner.category === 'ANAND_SWING':
       AnandDualTrackService.createEntries({
         symbol, token, hitPrice, alertId, scoreBreakdown
       })
         ├── INSERT intraday_entries (targetPct=5, stopPct=5)
         └── INSERT swing_entries   (targetPct=10, stopPct=10)
```

The dual-track creation is **additive** — the existing pipeline is untouched.

### 4.3 `AnandDualTrackService`

Responsibilities:
- `createEntries()` — inserts one row in each table from a single Chartink alert hit
- Captures the 10-factor `scoreBreakdown` JSON at entry time (passed in from `ChartinkProcessService` which already has it)
- Notifies `AnandPriceMonitorService` of the new tokens to subscribe

### 4.4 `AnandPriceMonitorService`

**On startup:**
1. Load all `WATCHING` entries from both tables
2. Determine market hours mode (09:00–15:30 IST) vs overnight mode
3. Subscribe to WS ticks (market hours) or start REST poll loop (overnight)

**During market hours (09:00–15:30 IST) — WebSocket mode:**
- Subscribe tokens to Angel One WS feed
- On each tick: compute `pnlPct = (ltp - entryPrice) / entryPrice * 100`
- If `pnlPct >= targetPct` → set `status = TARGET_HIT`, record `exitPrice = ltp`, `exitedAt = now()`
- If `pnlPct <= -stopPct` → set `status = STOPPED`, record `exitPrice`, `exitedAt`
- Intraday only: at 15:15 IST, mark all remaining `WATCHING` intraday entries as `EXPIRED`

**Overnight (15:30–09:00 IST) — REST polling mode:**
- Poll `getLiveQuote()` for each WATCHING swing entry every 30s
- Same hit/stop check as above
- Handles post-hours price gaps (circuit breaker open/close scenarios)
- On Angel One session expiry (~06:00 IST): log warning, retry every 30s until session is live again — same recovery pattern as the existing Watch poller

**Token cap management:**
- WS slots are shared with the existing MarketFeedService (50-token cap)
- Intraday entries are short-lived (same-day); swing entries are longer-lived
- Swing entries switch to REST polling outside market hours, freeing WS slots overnight
- During market hours, swing WATCHING entries join the WS subscription pool

### 4.5 `AnandDualTrackRepository`

Methods:
- `createIntradayEntry(data)` / `createSwingEntry(data)`
- `listIntradayEntries({ status?, from?, to? })` → with computed `pnlPct`, `targetLeftPct` using latest cached price
- `listSwingEntries({ status?, from?, to? })`
- `updateEntryStatus(table, id, { status, exitPrice, exitedAt })`
- `getPnlSummary(table)` → `{ daily, weekly, monthly, yearly }` — grouped by `exitedAt`, realized exits only

---

## 5. API Endpoints

Controller: `@Controller('api/anand')`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/anand/intraday/entries` | List intraday entries |
| `GET` | `/api/anand/swing/entries` | List swing entries |
| `GET` | `/api/anand/intraday/pnl-summary` | Daily/weekly/monthly/yearly P/L |
| `GET` | `/api/anand/swing/pnl-summary` | Same for swing |
| `PATCH` | `/api/anand/scanners/:id/category` | Tag scanner as ANAND_SWING |

**Query params for list endpoints:**
- `status` — `WATCHING | TARGET_HIT | STOPPED | EXPIRED`
- `from` — ISO date string
- `to` — ISO date string

**Entry response shape:**
```ts
{
  id: string
  symbol: string
  entryPrice: number
  enteredAt: string           // ISO
  targetPct: number
  stopPct: number
  status: string
  exitPrice: number | null
  exitedAt: string | null
  currentPrice: number        // latest cached tick from MarketDataService
  pnlPct: number              // (currentPrice - entryPrice) / entryPrice * 100
  targetLeftPct: number       // targetPct - pnlPct
  scoreBreakdown: ScoreCheck[]
}
```

**P/L summary shape:**
```ts
{
  daily:   { avgExitPct: number; count: number; winCount: number }
  weekly:  { avgExitPct: number; count: number; winCount: number }
  monthly: { avgExitPct: number; count: number; winCount: number }
  yearly:  { avgExitPct: number; count: number; winCount: number }
}
```

P/L is expressed as **percentage** (not rupees) — these are analysis logs with no position size. `avgExitPct` is the average `(exitPrice - entryPrice) / entryPrice * 100` across all exits in the window. `winCount` is exits where `exitPct > 0`.

---

## 6. Frontend

### 6.1 Routes & Navigation

New routes in `App.tsx`:
```
/intraday  →  IntradayPage
/swing     →  SwingPage
```

New sidebar entries (after Ungated Watch):
```ts
{ path: '/intraday', label: 'Intraday',  icon: Timer      }
{ path: '/swing',    label: 'Swing',     icon: TrendingUp }
```

### 6.2 File Structure

```
apps/web/src/
├── pages/
│   ├── intraday/
│   │   └── IntradayPage.tsx
│   └── swing/
│       └── SwingPage.tsx
├── services/
│   └── anand.ts            # listIntradayEntries, listSwingEntries, getPnlSummary, tagScanner
└── hooks/
    ├── useIntradayEntries.ts
    └── useSwingEntries.ts
```

### 6.3 Page Layout

Both pages share the same layout structure:

```
┌─ Header ───────────────────────────────────────────┐
│  "Intraday Track" / "Swing Track"                  │
│  Active: N  ·  Today avg exit: +X%  (real-time)     │
└────────────────────────────────────────────────────┘

┌─ P/L Summary Bar ──────────────────────────────────┐
│  Daily avg: +X%  Weekly: +X%  Monthly: +X%  Yearly  │
│  (avg exit % · win/total count)                    │
└────────────────────────────────────────────────────┘

┌─ Filters ──────────────────────────────────────────┐
│  [All] [Watching] [Target Hit] [Stopped] [Expired] │
│                                           [Date ▼] │
└────────────────────────────────────────────────────┘

┌─ Entries Table ─────────────────────────────────────────────────────┐
│ Symbol │ Entry ₹ │ Date & Time │ P/L % │ Target Left │ Status       │
│   ↕ (click to expand)                                               │
│   └── Score factor breakdown (ChartinkScoreTable, inline)           │
└─────────────────────────────────────────────────────────────────────┘
```

### 6.4 Differences Between Pages

| Feature | Intraday | Swing |
|---------|----------|-------|
| Target / Stop | 5% / 5% | 10% / 10% |
| `EXPIRED` status filter | shown | hidden |
| Overnight badge on WATCHING rows | — | "Overnight" badge shown |
| P/L summary label | same-day focus | multi-day |

### 6.5 Live Price Updates

On mount, each page subscribes to `wsService` tick events. On each tick matching a WATCHING entry's token, the row's `pnlPct` and `targetLeftPct` columns update in-place via a local `Map<token, price>` state — no full re-render. Same pattern as the existing Watch page.

### 6.6 Score Factor Breakdown

Each entry row is expandable. Clicking it renders `ChartinkScoreTable` inline (the existing component already used on the Chartink page), showing the 10-factor breakdown captured at entry time — green pass / red fail per factor, points earned vs possible.

---

## 7. Overnight Persistence Summary

| Scenario | Behaviour |
|----------|-----------|
| Server restart overnight | Monitor reloads all `WATCHING` swing entries from DB on startup, re-subscribes |
| Angel One session expiry (~06:00 IST) | Monitor detects stale quotes, logs warning, retries every 30s |
| Market hours (09:00–15:30 IST) | Swing entries on WS ticks; intraday entries on WS ticks |
| Outside market hours | Swing entries on 30s REST poll; intraday entries not relevant (expired at 15:15) |
| 50-token WS cap | Swing entries use REST overnight, freeing slots; during hours they join WS pool |

---

## 8. Out of Scope

- Real or paper trade execution (these are analysis logs only)
- Manual entry creation (all entries are auto-created from webhook)
- Editing `targetPct` / `stopPct` per entry
- Push notifications on target/stop hit (can be added later)

---

## 9. Implementation Order

1. Prisma schema — add `category` to `ChartinkScanner`, add `IntradayEntry` + `SwingEntry` models, `db push`
2. `anand-dual-track` module — repository, service, price monitor, controller
3. Wire into `ChartinkProcessService`
4. Tag the Anand Swing scanner via the PATCH endpoint
5. Frontend — service, hooks, pages, sidebar, routes
