# TDA-017 — USER UX Overhaul: Dashboard, Payments, Redesigned Intraday/Swing, 3D Depth

**Doc ID:** TDA-017
**Date:** 2026-07-04
**Status:** In design → ready for plan
**Owner:** development@panamoure.com
**Depends on:** TDA-007 (USER surface), TDA-015 (billing), TDA-005 (broker vault), TDA-011 (auto-execution)

> A user-facing UX overhaul delivered as **one coordinated release** (single commit + push
> at the end). Four features: a real **Payments** history page, a user **Dashboard**
> (their executed-trade performance + Angel One management), a **redesigned Intraday/Swing**
> (card/feed layout replacing the cockpit table), and a **tasteful CSS-3D depth system**
> applied across all pages including the landing page.

---

## 1. Goals & non-goals

**Goals**
- Give a USER a home Dashboard showing *their own* performance and broker status.
- Give a USER a Payments page backed by a **real** per-transaction ledger.
- Make Intraday/Swing feel distinct from the old TD-Automation cockpit — simple, interactive, mobile-friendly.
- Add depth/motion (tilt, parallax, glass, elevation) that reads as intentional, GPU-light, and accessible.

**Non-goals**
- No live trading — everything stays **paper mode** (`LIVE_TRADING_ENABLED=false`).
- No WebGL/three.js (explicitly rejected — CSS transforms only).
- No change to the ADMIN cockpit beyond extracting shared components.
- No new billing/payment *provider* behavior — only recording what the existing Razorpay webhook already receives.
- No browser-driving/screenshot verification — the user verifies UI themselves.

---

## 2. The four features

### 2.1 Payments page (only real backend work)

**Problem:** billing today records only `WebhookEvent { payloadHash }` — no amount, date, or invoice.
There is no per-payment data to show. This feature adds the missing ledger.

**Backend**
- **New tenant-owned Prisma model `Payment`:**
  ```
  model Payment {
    id                String        @id @default(cuid())
    userId            String
    user              User          @relation(fields: [userId], references: [id], onDelete: Cascade)
    segment           Segment?      // null for account-level charges
    amount            Int           // minor units (paise)
    currency          String        @default("INR")
    status            PaymentStatus // CAPTURED | FAILED | REFUNDED
    providerPaymentId String        @unique   // razorpay payment id — idempotency key
    providerInvoiceId String?
    invoiceUrl        String?
    description       String?
    createdAt         DateTime      @default(now())
    @@index([userId, createdAt])
    @@map("payments")
  }
  enum PaymentStatus { CAPTURED FAILED REFUNDED }
  ```
- **Forward migration hand-authored** (per the project's shadow-DB replay quirk — `prisma migrate dev --create-only` is broken repo-wide; author SQL + apply via `migrate deploy`). Numbered after the latest existing migration.
- **Webhook capture:** extend `billing-webhook.service` — on `payment.captured`, `invoice.paid`, `payment.failed` (and refunds if present), upsert a `Payment` keyed on `providerPaymentId` (insert-first / at-most-once, mirroring `WebhookEvent`). Resolve `userId` via the existing `BillingProfile.providerCustomerId` → user mapping. Written from the unauthenticated webhook worker via `runWithoutTenant` (same pattern as `SubscriptionService`).
- **`GET /api/me/billing/payments`** on `MeBillingController` (authenticated, tenant-scoped) → `Payment[]` newest-first, amounts as stringified minor units where needed.

**Frontend**
- `usePayments` hook (fetch + shape: group by month, format INR from paise).
- `PaymentsPage`: history list — **depth cards on mobile, table on desktop**; columns/fields: date, segment, amount, status badge, invoice link. Honest empty state ("No payments yet").
- Nav item **Payments** + route `/payments`.

### 2.2 User Dashboard

**Data source:** reuse existing **tenant-scoped** `/api/portfolio/*` endpoints (`summary`, `equity-curve`,
`daily-pnl`, `segments`) — TDA-003 Prisma auto-scoping already filters them to the calling user's rows,
so a USER gets *their own* executed-trade data with no new aggregation endpoint. Add a thin
`GET /api/me/dashboard` **only if** the combined shape proves materially cleaner than 3–4 client calls
(decide during implementation; default = reuse).

**Layout**
- **Hero:** total P&L + equity-curve sparkline (a `TiltCard`).
- **Panels:** P&L by segment (Intraday/Swing), recent trades, open-positions summary.
- **Angel One management:** broker connection status + connect/disconnect, by **extracting the existing
  `ConnectAngelOne` component out of `SettingsPage` into a shared `components/broker/ConnectAngelOne.tsx`**
  so Dashboard and Settings render one source of truth (no duplicate broker form).
- Empty-state aware (paper mode: a user may have zero executed trades — show an inviting empty hero, not a broken chart).

**Routing:** USER index `/` → `DashboardPage` (currently redirects to `/intraday`). ADMIN index unchanged (ADMIN dashboard). Nav item **Dashboard** for USER.

### 2.3 Intraday/Swing redesign

- **New shared components** in `components/signals/`:
  - `SignalCard` — one entry: symbol, entry/target/stop, live price + Δ%, P&L ₹/%, status pill, entry time. Interactive: hover depth, expand for detail. Touch-friendly.
  - `SignalSummaryStrip` — the period P&L cards + open-book capital strip, restyled.
- Both `IntradayPage` and `SwingPage` consume these; **data hooks unchanged** (`useIntradayEntries`, `useSwingEntries`), **subscribe-gate + no-403 behavior preserved** exactly.
- **ADMIN provenance boundary preserved (critical):** scanner name, `scoreBreakdown` (`ChartinkScoreTable`), trailing/exitReason render **only** inside an ADMIN-only expandable section of `SignalCard`, never in the USER render path. This upholds the TDA-006 boundary — the USER card physically cannot show provenance fields.

### 2.4 3D / depth visual system (cross-cutting foundation)

- **Shared primitives** in `components/depth/`:
  - `TiltCard` — pointer-tracked 3D tilt (rotateX/rotateY on `transform`, `perspective` parent), subtle glare optional.
  - `ParallaxHero` — layered parallax on scroll/pointer for landing + dashboard hero.
- **Depth tokens + glass utilities** added to `app.css`: elevation shadow scale, `--depth-*` vars, `.glass` surface, all **light/dark aware** via the existing CSS-variable theme.
- **Accessibility:** every effect gated behind `@media (prefers-reduced-motion: reduce)` → falls back to static. No effect blocks interaction or text legibility.
- **Consumers:** Landing (hero), Dashboard/Payments (TiltCard panels), Intraday/Swing (SignalCard depth). CSS transforms only — no bundle-heavy libraries.

---

## 3. Nav & routing changes

USER-visible nav (single source of truth = `navItems.ts` `USER_VISIBLE` set):

```
Dashboard · Intraday · Swing · Positions · Payments · Market · Charts · Settings
```

(Market + Charts kept per owner decision.) New paths: `/` (USER→Dashboard), `/payments`.
ADMIN nav unchanged. `App.tsx`: add `/payments` route (USER-reachable), change USER index element to `DashboardPage`.

---

## 4. Architecture & module boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `Payment` model + migration | Persist per-transaction ledger | Prisma schema |
| `billing-webhook.service` (extended) | Upsert `Payment` on payment events, idempotent | `Payment`, `BillingProfile` |
| `MeBillingController.payments` | Serve user's payments | `BillingService` |
| `usePayments`, `PaymentsPage` | Render history | payments endpoint |
| `useDashboard`, `DashboardPage` | Render user performance + broker | `/api/portfolio/*`, `/broker/status` |
| `components/broker/ConnectAngelOne` (extracted) | Broker connect/disconnect (shared) | `/broker/*` |
| `components/signals/SignalCard`, `SignalSummaryStrip` | Interactive signal UI | data hooks |
| `components/depth/TiltCard`, `ParallaxHero` + `app.css` tokens | Depth/motion primitives | theme vars |

Each unit is independently understandable, has a defined interface, and is testable in isolation.

---

## 5. Agent team & coordination

Built as **two waves** to avoid collisions on the shared hot-spot files (`App.tsx`, `navItems.ts`, `app.css`).
All agents dispatched on **opus**. Each Wave-2 page gets an adversarial review; a **whole-branch review**
runs before the final commit (project lesson: per-task gates miss cross-cutting issues — e.g. a leaked
provenance field or a reduced-motion regression).

**Wave 1 — foundations (parallel):**
- **Agent A — Payments backend:** `Payment` model + hand-authored migration + webhook capture + `GET /api/me/billing/payments` + backend tests.
- **Agent B — Depth system + shared shells:** `TiltCard`/`ParallaxHero`, `app.css` depth tokens, extract shared `ConnectAngelOne`, scaffold `SignalCard`/`SignalSummaryStrip` component APIs.

**Wave 2 — pages (parallel; depend on Wave 1):**
- **Agent C — Payments page:** `usePayments` + `PaymentsPage` (needs A's endpoint).
- **Agent D — Dashboard page:** `useDashboard` + `DashboardPage` + broker panel (needs B's primitives + shared broker component).
- **Agent E — Intraday/Swing redesign:** wire `SignalCard`/`SignalSummaryStrip` into both pages, ADMIN provenance in expandable detail (needs B's `SignalCard`).
- **Agent F — Landing 3D pass:** apply `ParallaxHero`/depth to `LandingPage` (needs B's primitives).

**Serialized integration (single owner, additive):** wire `App.tsx` routes + `navItems.ts` `USER_VISIBLE`
after pages exist, so route/nav edits never conflict. `app.css` is owned solely by Agent B in Wave 1;
Wave-2 agents consume tokens, never edit `app.css`.

---

## 6. Testing & verification

- **Payments backend:** Jest (reuse tda008/tda015 harness) — webhook→`Payment` idempotency (duplicate `providerPaymentId` is a no-op), endpoint returns only the caller's rows (tenant-scoping), amount/status mapping.
- **Frontend:** Vitest pure-logic for `usePayments`/`useDashboard` shaping and any card-state helpers. No jsdom/browser-driving.
- **Manual:** the **user verifies the UI themselves** (standing preference) — no Playwright/screenshots.
- **Regime:** paper mode; no live broker calls; no secret leakage (the tda004 no-secret-leak guard still applies).

---

## 7. Definition of Done

- A USER logging in lands on a **Dashboard** showing their P&L (or an inviting empty state) and their Angel One connection status with connect/disconnect.
- A **Payments** page lists real captured/failed/refunded transactions from a `Payment` ledger populated by the Razorpay webhook; empty state is honest.
- **Intraday & Swing** render as interactive cards with a summary strip; USER never sees provenance; ADMIN retains full detail in an expandable section; subscribe-gate + no-403 behavior intact.
- **Depth/motion** applies across pages incl. landing, is light/dark aware, and fully disabled under `prefers-reduced-motion`.
- Nav shows `Dashboard · Intraday · Swing · Positions · Payments · Market · Charts · Settings` for USER; ADMIN unchanged.
- Everything lands in **one commit + push** after a whole-branch review and user UI verification.

---

## 8. Risks & mitigations

- **Provenance leak in redesigned cards** — the highest-risk change. Mitigation: ADMIN-only render path is a hard branch inside `SignalCard`; whole-branch review explicitly checks the USER payload for `scanner`/`score`/`trailing`/`exitReason`.
- **Shared-file merge conflicts** (`App.tsx`, `navItems.ts`, `app.css`) — mitigated by the wave/ownership rules in §5.
- **Migration on fresh DB** — hand-authored + applied via `migrate deploy`; numbered after the latest migration; verify against `td_saas` before commit.
- **Motion/perf on data tables** — CSS-only transforms, reduced-motion fallback, no per-row WebGL.
