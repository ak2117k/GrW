# TDA-007 — Sanitized User Surface (Intraday/Swing) + Plan-Gating — Design Spec

**Doc ID:** TDA-007
**Date:** 2026-06-28 (rev. 2026-06-29 after code mapping)
**Sprint:** S3 (IP Boundary & Product Surface) — MVP
**Depends on:** TDA-006 (`toPublicEntry`, ADMIN-gating), TDA-003 (RBAC + tenant scoping), TDA-002 (`/auth/me` role, Zustand auth store), TDA-001 (`Subscription`, `Segment` enum)
**Blocks:** TDA-016 (mobile reuses these endpoints)
**Owner:** development@panamoure.com

---

## 1. Goal

Turn the app a **USER** sees from the full single-user cockpit (~26 routes,
provenance on the Intraday/Swing pages) into the designed product:
**Intraday · Swing · Positions · Settings**, plan-gated by an active
`Subscription`. ADMIN keeps the full cockpit unchanged. This sprint finally
makes the visible product match the locked design.

## 2. Current state (from code map) — what we're changing

- **Routing** (`apps/web/src/App.tsx`): one `RequireAuth` wrapper (checks
  authed vs anon only — **no role gating**) around `<AppLayout/>` with ~26 child
  routes, all reachable by any logged-in user.
- **Nav** (`apps/web/src/components/layout/Sidebar.tsx`): a static module-level
  `navItems: NavItem[]` (25 items) rendered as `<NavLink>`s. No role filter.
- **Role on client**: there is **no JWT decode and no `useAuth`**. The user
  (incl. `role`) comes from `GET /auth/me` into a Zustand store
  (`apps/web/src/stores/auth-store.ts`). A component reads role via
  `useAuthStore((s) => s.user?.role)` (string, e.g. `'ADMIN'`/`'USER'`).
- **Intraday/Swing pages** already exist (`pages/intraday/IntradayPage.tsx`,
  `pages/swing/SwingPage.tsx`) and **already render provenance** (Scanner column,
  `ChartinkScoreTable` score breakdown, lead counts, trailing/exitReason). They
  fetch via `apps/web/src/services/anand.ts` (`/api/anand/...`).
- **Positions** (`pages/positions/PositionsPage.tsx`) uses `useTrades`
  (Zustand `trade-store` + WS) and is tenant-scoped server-side (TDA-003).

## 3. Role-based surface — two enforcement layers

### 3.1 Frontend (UX)
- **Role-filtered nav:** give each `NavItem` an optional `adminOnly?: boolean`.
  Mark every cockpit item `adminOnly: true` **except** the four product items:
  `/intraday`, `/swing`, `/positions`, `/settings`. `Sidebar` filters
  `navItems` by `useAuthStore((s) => s.user?.role) === 'ADMIN'`. A USER sees
  exactly 4 items; ADMIN sees all 25.
- **Route guard:** a `<RequireRole role="ADMIN">` wrapper (mirrors `RequireAuth`)
  that `<Navigate to="/intraday" replace>` if the user is not ADMIN. Wrap every
  ADMIN-only `<Route>` in `App.tsx`. A USER typing `/chartink` lands on
  `/intraday`. The index route (`/`) for a USER renders/redirects to Intraday;
  ADMIN keeps the Dashboard.

### 3.2 Backend (authority)
Frontend hiding is cosmetic; the server is the authority:
- `/api/signals/*`, chartink, rejections → `@AdminOnly()` (TDA-006 §4).
- The anand endpoints serialize via `toPublicEntry` for USERs (TDA-006 §3) and
  additionally enforce the **subscription gate** (§5).

## 4. The Intraday / Swing user pages

Keep the existing pages; branch by role so USERs get the sanitized product:
- **Sanitized data:** for a USER, `anand.ts` calls return `PublicAnandEntry`
  (no scanner/score/leads/exitReason). The `AnandEntry` TS type splits into
  `PublicAnandEntry` (always) + optional provenance fields (ADMIN only).
- **Sanitized UI:** in `IntradayPage`/`SwingPage`, the **Scanner column**, the
  click-to-expand **`ChartinkScoreTable`**, the **Leads** column, and
  **trailing/exitReason** badges render **only when** `role === 'ADMIN'`. A USER
  sees: Symbol, Entry, Price/Δ%, P&L ₹, P&L %, Target, Status, Time — and the
  `CapitalStrip`/PnL bar (those are the user's own economics, fine to show).
- **Positions** page = the user's own positions (already tenant-scoped); reused
  as-is for USERs.
- **Settings** = account hub (§6).

## 5. Plan-gating (your "enforce now" choice)

### 5.1 Backend gate
- A reusable check (`SubscriptionService.hasActive(userId, segment)`): an active
  `Subscription` = `userId` matches, `segment` matches, `status === 'ACTIVE'`,
  and (`expiresAt == null || expiresAt > now`).
- Applied in the anand controller’s intraday endpoints (`segment INTRADAY`) and
  swing endpoints (`segment SWING`) for non-ADMIN: if no active subscription →
  **403** with body `{ code: 'NOT_SUBSCRIBED', segment }`. ADMIN bypasses.

### 5.2 Frontend placeholder
- The Intraday/Swing pages first check subscription status (from a new
  `GET /api/me/subscriptions` → `{ INTRADAY: boolean, SWING: boolean }`, or by
  catching the `NOT_SUBSCRIBED` 403). If not subscribed → render a **"Subscribe
  to {Intraday|Swing}"** card with a **stub CTA** (`onClick` → "Checkout coming
  soon" toast; real checkout = TDA-015). **No entries are fetched/shown.**

### 5.3 ADMIN grant (testing affordance)
- `POST /api/admin/subscriptions` `@AdminOnly()` — body
  `{ userId, segment, expiresAt? }` → upserts an `ACTIVE` `Subscription`
  (`@@unique([userId, segment])` → upsert on that pair).
- `DELETE /api/admin/subscriptions` `@AdminOnly()` — body `{ userId, segment }`
  → revoke. Lets us exercise gated views before billing exists.

## 6. Settings — account hub (real where possible, honest placeholders else)

`SettingsPage` becomes the USER account home:
- **Subscriptions** — per-segment status (real, from `/api/me/subscriptions`).
  Subscribe CTA stubbed (TDA-015).
- **Connect Angel One** — placeholder card ("Connect your broker account"), real
  encrypted flow in TDA-005.
- **Consent / disclaimer** — placeholder state, real versioned gate in TDA-009.
- **Auto-execution toggle** — placeholder (disabled), real opt-in in TDA-011.
- **Account** — email (from auth store), logout (existing `logout`).

Each placeholder states what it will do and which sprint delivers it — honest,
not fake-functional. (Existing rich ADMIN `SettingsPage` content, if any, stays
behind the ADMIN role.)

## 7. Out of scope (deferred)

Real broker connect (TDA-005), real consent gate (TDA-009), auto-execution
(TDA-010/011), payments/checkout (TDA-015), landing page (TDA-014). This sprint
delivers: correct USER surface, sanitized Intraday/Swing, plan-gating structure.

## 8. Acceptance criteria

1. USER login → nav shows exactly **Intraday, Swing, Positions, Settings**;
   ADMIN login → full 25-item cockpit unchanged.
2. USER typing any ADMIN URL (e.g. `/chartink`) → redirected to `/intraday`;
   never renders provenance.
3. Subscribed segment → sanitized entries (no scanner/score/leads/exitReason in
   the rendered DOM or network payload) + own positions; unsubscribed segment →
   Subscribe placeholder, **no entries fetched**.
4. Backend anand endpoints enforce the subscription gate server-side (USER w/o
   sub → 403 `NOT_SUBSCRIBED`); ADMIN bypasses.
5. `POST /api/admin/subscriptions` grants a segment; the page then renders the
   sanitized feed for that user.
6. Settings shows real per-segment subscription status + honest placeholders.

## 9. Test plan

- **Backend (`apps/api/test/tda007/`):** `SubscriptionService.hasActive` matrix
  (active/expired/wrong-segment/none); anand endpoint gate (USER no-sub→403,
  USER sub→200 sanitized, ADMIN→bypass raw); `/api/me/subscriptions` shape; admin
  grant/revoke flips the gate. Reuse tda003 Style-B (real DB, two clients,
  `asTenant`) for the DB-backed gate tests and Style-A for role/HTTP.
- **Frontend (Vitest, pure-logic):** the `navItems` role-filter selector
  (USER→4, ADMIN→25); a `PublicAnandEntry`-vs-provenance type guard used by the
  page to decide column rendering. (No jsdom render tests — repo has none wired.)
- **E2E smoke (Playwright, `test:e2e`):** `viewer@panamoure.com` USER → log in →
  4-item nav → Swing shows Subscribe placeholder → ADMIN grants Swing → reload →
  Swing shows sanitized entries; assert no `scannerName`/`scoreBreakdown` in the
  captured `/api/anand/swing/*` network responses.
