# TDA-007 User Surface (Intraday/Swing) + Plan-Gating — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Reduce the USER-visible app to Intraday · Swing · Positions · Settings (ADMIN keeps the full cockpit), plan-gate the two segments against the `Subscription` table, and serve only sanitized Intraday/Swing data — finally making the visible product match the design.

**Architecture:** Backend adds a `SubscriptionService.hasActive()` gate on the anand segment endpoints, a `GET /api/me/subscriptions` status endpoint, and an `@AdminOnly` grant/revoke endpoint. Frontend filters the static `navItems` by role, wraps cockpit routes in `<RequireRole role="ADMIN">`, role-gates the provenance columns on the existing Intraday/Swing pages, renders a Subscribe placeholder when unsubscribed, and turns Settings into an account hub.

**Tech Stack:** Backend NestJS 11 + Prisma 6 (`Subscription`, `Segment` enum INTRADAY/SWING, `@@unique([userId, segment])`). Frontend React 19 + react-router-dom 7 + Zustand (`useAuthStore`, role from `/auth/me`) + axios `/api` instance + Vitest. Builds on TDA-006 (`toPublicEntry`, ADMIN-gated routes).

## Global Constraints

- **DB:** dev `td_saas`, tests `td_saas_test`. Never `prisma migrate reset`. **No schema change** (Subscription exists from TDA-001).
- **Commit prefix:** `TDA-007:`. No `.env`. Stage only changed files.
- **USER product surface (exact 4):** `/intraday`, `/swing`, `/positions`, `/settings`. Everything else is ADMIN-only.
- **Active subscription =** `userId` matches AND `segment` matches AND `status === 'ACTIVE'` AND (`expiresAt == null` OR `expiresAt > now`).
- **Gate response:** USER without an active sub on a segment endpoint → HTTP **403** body `{ code: 'NOT_SUBSCRIBED', segment }`. ADMIN bypasses all gating.
- **Role on client:** `useAuthStore((s) => s.user?.role)` (string; `'ADMIN'` is privileged). No JWT decode.
- **Backend tests** (`apps/api/test/tda007/`, own `jest.config.js` mirroring tda003) run from `apps/api`: `npx jest --config test/tda007/jest.config.js -v` (DB specs prefixed `DATABASE_URL_TEST=...`). **Frontend tests:** Vitest, from `apps/web`: `npx vitest run <file>`. Pure-logic only (no jsdom configured).

---

## File Structure

**Backend**
- `apps/api/src/modules/subscription/subscription.service.ts` — **create.** `hasActive`, `listForUser`, `grant`, `revoke`.
- `apps/api/src/modules/subscription/subscription.module.ts` — **create.** Provides/exports `SubscriptionService`.
- `apps/api/src/modules/subscription/me-subscription.controller.ts` — **create.** `GET /api/me/subscriptions`.
- `apps/api/src/modules/subscription/admin-subscription.controller.ts` — **create.** `POST`/`DELETE /api/admin/subscriptions` (`@AdminOnly`).
- `apps/api/src/modules/anand-dual-track/controllers/anand-dual-track.controller.ts` — **modify.** Inject `SubscriptionService`; gate `listIntraday`/`intradayPnl` (INTRADAY) and `listSwing`/`listSwingExits`/`swingPnl` (SWING) for non-ADMIN.
- `apps/api/src/modules/anand-dual-track/anand-dual-track.module.ts` — **modify.** Import `SubscriptionModule`.
- `apps/api/src/app.module.ts` — **modify.** Add `SubscriptionModule`.

**Frontend**
- `apps/web/src/types/index.ts` — **modify.** Add `adminOnly?: boolean` to `NavItem`.
- `apps/web/src/components/layout/Sidebar.tsx` — **modify.** Mark cockpit items `adminOnly`; filter by role.
- `apps/web/src/components/layout/navItems.ts` — **create** (extract array for testability) + `visibleNavItems(role)`.
- `apps/web/src/App.tsx` — **modify.** Add `<RequireRole>`; wrap ADMIN routes; USER index → Intraday.
- `apps/web/src/services/anand.ts` — **modify.** Split `AnandEntry` into `PublicAnandEntry` + optional provenance.
- `apps/web/src/hooks/useSubscriptions.ts` — **create.** Fetch `/api/me/subscriptions`.
- `apps/web/src/pages/intraday/IntradayPage.tsx`, `pages/swing/SwingPage.tsx` — **modify.** Role-gate provenance columns; subscription placeholder.
- `apps/web/src/components/product/SubscribeCard.tsx` — **create.** Placeholder card.
- `apps/web/src/pages/settings/SettingsPage.tsx` — **modify.** Account hub (USER view).
- Tests: `apps/api/test/tda007/{jest.config.js,otplib.stub.js,subscription.spec.ts,gate.spec.ts,admin-grant.spec.ts}`; `apps/web/src/components/layout/navItems.spec.ts`.

---

### Task 1: `SubscriptionService` (hasActive / list / grant / revoke)

**Files:**
- Create: `apps/api/src/modules/subscription/subscription.service.ts`, `subscription.module.ts`
- Test: `apps/api/test/tda007/subscription.spec.ts` (+ copy tda003 `jest.config.js`→`test/tda007/jest.config.js` with roots → `test/tda007`, and `otplib.stub.js`)

**Interfaces — Produces:**
- `SubscriptionService.hasActive(userId: string, segment: 'INTRADAY'|'SWING'): Promise<boolean>`
- `SubscriptionService.listForUser(userId: string): Promise<{ INTRADAY: boolean; SWING: boolean }>`
- `SubscriptionService.grant(userId, segment, expiresAt?: Date | null): Promise<void>` (upsert ACTIVE)
- `SubscriptionService.revoke(userId, segment): Promise<void>` (set status `CANCELLED`)

**Context:** `Subscription { userId, segment: Segment, status: SubscriptionStatus @default(ACTIVE), expiresAt: DateTime?, @@unique([userId, segment]) }`. `Subscription` is a TENANT_MODEL (TDA-003) — so reads/writes here must run **unscoped** (admin grant operates across users; the `hasActive` check uses the explicit `userId`). Inject `PrismaService` and use `TenantContextService.runWithoutTenant(...)` for these queries, OR query with explicit `userId` under an ADMIN/no context. Use `runWithoutTenant` to be safe.

- [ ] **Step 1: Write the failing test** — `subscription.spec.ts` (Style-B: real DB, raw seed, the service under test). Seed two users + subscriptions via a raw `PrismaClient`:

```ts
import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { SubscriptionService } from '../../src/modules/subscription/subscription.service';

const url = process.env.DATABASE_URL_TEST!; process.env.DATABASE_URL = url;
const raw = new PrismaClient({ datasources: { db: { url } } });
const cls = new ClsService(new AsyncLocalStorage()); const tenant = new TenantContextService(cls);
const prisma = new PrismaService(tenant);
const svc = new SubscriptionService(prisma, tenant);

let uId: string;
const E = 'tda007-sub@test.local';
beforeAll(async () => {
  await prisma.onModuleInit();
  await raw.subscription.deleteMany({ where: { user: { email: E } } });
  await raw.user.deleteMany({ where: { email: E } });
  const u = await raw.user.create({ data: { email: E, passwordHash: 'x', role: 'USER' } });
  uId = u.id;
  await raw.subscription.create({ data: { userId: uId, segment: 'INTRADAY', status: 'ACTIVE' } });
  await raw.subscription.create({ data: { userId: uId, segment: 'SWING', status: 'ACTIVE', expiresAt: new Date(Date.now() - 1000) } }); // expired
});
afterAll(async () => {
  await raw.subscription.deleteMany({ where: { userId: uId } });
  await raw.user.deleteMany({ where: { email: E } });
  await raw.$disconnect(); await prisma.$disconnect();
});

it('hasActive true for ACTIVE non-expired', async () => expect(await svc.hasActive(uId, 'INTRADAY')).toBe(true));
it('hasActive false for expired', async () => expect(await svc.hasActive(uId, 'SWING')).toBe(false));
it('hasActive false when no row', async () => expect(await svc.hasActive('nope', 'INTRADAY')).toBe(false));
it('listForUser reports per-segment booleans', async () =>
  expect(await svc.listForUser(uId)).toEqual({ INTRADAY: true, SWING: false }));
it('grant upserts ACTIVE; revoke cancels', async () => {
  await svc.grant(uId, 'SWING', null);
  expect(await svc.hasActive(uId, 'SWING')).toBe(true);
  await svc.revoke(uId, 'SWING');
  expect(await svc.hasActive(uId, 'SWING')).toBe(false);
});
```

- [ ] **Step 2: Run → FAIL** (`DATABASE_URL_TEST=postgresql://postgres:<pw>@127.0.0.1:5432/td_saas_test npx jest --config test/tda007/jest.config.js subscription -v`).

- [ ] **Step 3: Implement** `subscription.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';

export type Seg = 'INTRADAY' | 'SWING';

@Injectable()
export class SubscriptionService {
  constructor(private readonly prisma: PrismaService, private readonly tenant: TenantContextService) {}

  hasActive(userId: string, segment: Seg): Promise<boolean> {
    return this.tenant.runWithoutTenant(async () => {
      const row = await this.prisma.subscription.findFirst({
        where: {
          userId, segment, status: 'ACTIVE',
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { id: true },
      });
      return !!row;
    });
  }

  async listForUser(userId: string): Promise<{ INTRADAY: boolean; SWING: boolean }> {
    const [intraday, swing] = await Promise.all([this.hasActive(userId, 'INTRADAY'), this.hasActive(userId, 'SWING')]);
    return { INTRADAY: intraday, SWING: swing };
  }

  grant(userId: string, segment: Seg, expiresAt: Date | null = null): Promise<void> {
    return this.tenant.runWithoutTenant(async () => {
      await this.prisma.subscription.upsert({
        where: { userId_segment: { userId, segment } },
        update: { status: 'ACTIVE', expiresAt },
        create: { userId, segment, status: 'ACTIVE', expiresAt },
      });
    });
  }

  revoke(userId: string, segment: Seg): Promise<void> {
    return this.tenant.runWithoutTenant(async () => {
      await this.prisma.subscription.updateMany({ where: { userId, segment }, data: { status: 'CANCELLED' } });
    });
  }
}
```
Create `subscription.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { SubscriptionService } from './subscription.service';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { TenantModule } from '../../common/tenant/tenant.module';

@Module({ imports: [PrismaModule, TenantModule], providers: [SubscriptionService], exports: [SubscriptionService] })
export class SubscriptionModule {}
```
(Confirm the `@@unique([userId, segment])` compound input name is `userId_segment` via `npx prisma generate` types.)

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-007: SubscriptionService (hasActive/list/grant/revoke)`.

---

### Task 2: `/api/me/subscriptions` + `/api/admin/subscriptions` endpoints

**Files:**
- Create: `apps/api/src/modules/subscription/me-subscription.controller.ts`, `admin-subscription.controller.ts`
- Modify: `subscription.module.ts` (register controllers), `apps/api/src/app.module.ts` (import `SubscriptionModule`)
- Test: `apps/api/test/tda007/admin-grant.spec.ts`

**Interfaces — Consumes:** `SubscriptionService` (Task 1), `@CurrentUser`, `@AdminOnly`.

- [ ] **Step 1: Write the failing test** (Style-A HTTP harness importing `SubscriptionModule` + Auth/Tenant; mint JWTs). Seed a USER via raw client; its `userId` must equal the `sub` claim. Simplest: mint the USER token with `sub` set to a real seeded user id (sign manually). Assertions:

```ts
it('USER /api/me/subscriptions returns both-false before grant', async () => {
  const { status, body } = await getJson('/api/me/subscriptions', userToken);
  expect(status).toBe(200); expect(body).toEqual({ INTRADAY: false, SWING: false });
});
it('USER cannot POST /api/admin/subscriptions (403)', async () =>
  expect((await postJson('/api/admin/subscriptions', { userId, segment:'SWING' }, userToken)).status).toBe(403));
it('ADMIN grant then USER sees SWING true', async () => {
  expect((await postJson('/api/admin/subscriptions', { userId, segment:'SWING' }, adminToken)).status).toBe(201);
  expect((await getJson('/api/me/subscriptions', userToken)).body).toEqual({ INTRADAY: false, SWING: true });
});
```
(Add a `postJson` helper mirroring `getJson` with `method:'POST'`, JSON body + `content-type`.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** `me-subscription.controller.ts`:
```ts
import { Controller, Get } from '@nestjs/common';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators';
import { SubscriptionService } from './subscription.service';

@Controller('api/me/subscriptions')
export class MeSubscriptionController {
  constructor(private readonly subs: SubscriptionService) {}
  @Get()
  list(@CurrentUser() user: AuthenticatedUser) { return this.subs.listForUser(user.userId); }
}
```
`admin-subscription.controller.ts`:
```ts
import { Body, Controller, Delete, Post } from '@nestjs/common';
import { AdminOnly } from '../../common/decorators';
import { SubscriptionService, Seg } from './subscription.service';

@AdminOnly()
@Controller('api/admin/subscriptions')
export class AdminSubscriptionController {
  constructor(private readonly subs: SubscriptionService) {}
  @Post()
  async grant(@Body() b: { userId: string; segment: Seg; expiresAt?: string }) {
    await this.subs.grant(b.userId, b.segment, b.expiresAt ? new Date(b.expiresAt) : null);
    return { ok: true };
  }
  @Delete()
  async revoke(@Body() b: { userId: string; segment: Seg }) {
    await this.subs.revoke(b.userId, b.segment);
    return { ok: true };
  }
}
```
Register both in `subscription.module.ts` `controllers: [...]`, and add `SubscriptionModule` to `app.module.ts` imports.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-007: me + admin subscription endpoints`.

---

### Task 3: Subscription gate on the anand segment endpoints

**Files:**
- Modify: `apps/api/src/modules/anand-dual-track/controllers/anand-dual-track.controller.ts`, `anand-dual-track.module.ts` (import `SubscriptionModule`)
- Test: `apps/api/test/tda007/gate.spec.ts`

**Interfaces — Consumes:** `SubscriptionService.hasActive`, `@CurrentUser`. **Builds on TDA-006 Task 2** (these handlers already inject `@CurrentUser()` and serialize via `toPublicEntry`).

**Context:** gate INTRADAY handlers (`listIntraday`, `intradayPnl`) and SWING handlers (`listSwing`, `listSwingExits`, `swingPnl`). ADMIN bypasses.

- [ ] **Step 1: Write the failing test** (Style-A; seed user; grant via raw client):

```ts
it('USER without sub → 403 NOT_SUBSCRIBED on intraday entries', async () => {
  const { status, body } = await getJson('/api/anand/intraday/entries', userToken);
  expect(status).toBe(403); expect(body?.code).toBe('NOT_SUBSCRIBED'); expect(body?.segment).toBe('INTRADAY');
});
it('USER with INTRADAY sub → 200', async () => {
  await raw.subscription.upsert({ where:{ userId_segment:{ userId, segment:'INTRADAY' } }, update:{ status:'ACTIVE' }, create:{ userId, segment:'INTRADAY', status:'ACTIVE' } });
  expect((await getJson('/api/anand/intraday/entries', userToken)).status).toBe(200);
});
it('ADMIN bypasses the gate', async () =>
  expect((await getJson('/api/anand/intraday/entries', adminToken)).status).toBe(200));
```

- [ ] **Step 2: Run → FAIL** (currently 200 without sub).

- [ ] **Step 3: Implement** — add a private guard helper and call it at the top of each gated handler:

```ts
import { ForbiddenException } from '@nestjs/common';
import { SubscriptionService, Seg } from '../../subscription/subscription.service';
// constructor: ..., private readonly subs: SubscriptionService

private async assertSubscribed(user: AuthenticatedUser, segment: Seg): Promise<void> {
  if (user?.role === 'ADMIN') return;
  if (!(await this.subs.hasActive(user.userId, segment))) {
    throw new ForbiddenException({ code: 'NOT_SUBSCRIBED', segment });
  }
}
```
At the start of `listIntraday`/`intradayPnl`: `await this.assertSubscribed(user, 'INTRADAY');` (add `@CurrentUser() user` to `intradayPnl`/`swingPnl`, which currently take none). For swing handlers: `'SWING'`. Add `SubscriptionModule` to `anand-dual-track.module.ts` imports.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-007: plan-gate anand segment endpoints by subscription`.

---

### Task 4: Role-filtered nav

**Files:**
- Modify: `apps/web/src/types/index.ts` (add `adminOnly?: boolean` to `NavItem`)
- Create: `apps/web/src/components/layout/navItems.ts` (extract the array + `visibleNavItems`)
- Modify: `apps/web/src/components/layout/Sidebar.tsx` (import array; filter by role)
- Test: `apps/web/src/components/layout/navItems.spec.ts`

**Interfaces — Produces:** `export const navItems: NavItem[]`; `export function visibleNavItems(role: string | null | undefined): NavItem[]`.

- [ ] **Step 1: Write the failing test** — `navItems.spec.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { navItems, visibleNavItems } from './navItems';

const USER_PATHS = ['/intraday','/swing','/positions','/settings'];
describe('visibleNavItems', () => {
  it('USER sees exactly the four product items', () => {
    expect(visibleNavItems('USER').map(i => i.path).sort()).toEqual([...USER_PATHS].sort());
  });
  it('ADMIN sees every item', () => {
    expect(visibleNavItems('ADMIN').length).toBe(navItems.length);
  });
  it('treats null/unknown role as USER (fail closed)', () => {
    expect(visibleNavItems(null).map(i => i.path).sort()).toEqual([...USER_PATHS].sort());
  });
});
```

- [ ] **Step 2: Run → FAIL** (`cd apps/web && npx vitest run src/components/layout/navItems.spec.ts`).

- [ ] **Step 3: Implement** — move the `navItems` array from `Sidebar.tsx` into `navItems.ts`, adding `adminOnly: true` to every item EXCEPT the four product paths. Append:
```ts
const USER_VISIBLE = new Set(['/intraday','/swing','/positions','/settings']);
export function visibleNavItems(role: string | null | undefined): NavItem[] {
  if (role === 'ADMIN') return navItems;
  return navItems.filter((i) => USER_VISIBLE.has(i.path));
}
```
(Equivalently each non-product item carries `adminOnly:true` and the filter is `!i.adminOnly`; keep ONE source of truth — the `USER_VISIBLE` set — to avoid drift.) In `Sidebar.tsx`: `import { visibleNavItems } from './navItems';` and `const role = useAuthStore((s) => s.user?.role); const items = visibleNavItems(role);` then map `items` instead of the local array.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-007: role-filtered sidebar nav`.

---

### Task 5: `<RequireRole>` route guard

**Files:**
- Modify: `apps/web/src/App.tsx`

**Interfaces — Produces:** `RequireRole({ role, children })` — redirects non-matching users to `/intraday`.

**Context:** mirrors the existing `RequireAuth`. `App.tsx` already imports `useAuthStore`, `Navigate`. ADMIN-only routes = every child route except `index`(see below), `intraday`, `swing`, `positions`, `settings`.

- [ ] **Step 1: Implement the guard** (no unit test — repo has no router render tests; covered by E2E in Task 8):
```tsx
function RequireRole({ role, children }: { role: string; children: ReactNode }) {
  const userRole = useAuthStore((s) => s.user?.role);
  if (userRole !== role) return <Navigate to="/intraday" replace />;
  return <>{children}</>;
}
```

- [ ] **Step 2: Wrap ADMIN routes.** For each ADMIN-only `<Route>`, wrap the element: e.g.
`<Route path="chartink" element={<RequireRole role="ADMIN"><ChartinkPage /></RequireRole>} />`.
Leave `intraday`, `swing`, `positions`, `settings` unwrapped. For the index route, make it role-aware so a USER doesn't see the ADMIN Dashboard:
```tsx
<Route index element={
  <RequireRoleSwitch admin={<DashboardPage />} user={<Navigate to="/intraday" replace />} />
} />
```
where:
```tsx
function RequireRoleSwitch({ admin, user }: { admin: ReactNode; user: ReactNode }) {
  const role = useAuthStore((s) => s.user?.role);
  return <>{role === 'ADMIN' ? admin : user}</>;
}
```

- [ ] **Step 3: Manual smoke** — `npm run build` in `apps/web` (tsc + vite) to confirm no type errors; full behavior verified in Task 8 E2E.
Run: `cd apps/web && npx tsc -b --noEmit` Expected: no errors.

- [ ] **Step 4: Commit** `TDA-007: RequireRole route guard; USER index → Intraday`.

---

### Task 6: Sanitized Intraday/Swing UI + Subscribe placeholder

**Files:**
- Modify: `apps/web/src/services/anand.ts` (`AnandEntry` → `PublicAnandEntry` + optional provenance)
- Create: `apps/web/src/hooks/useSubscriptions.ts`
- Create: `apps/web/src/components/product/SubscribeCard.tsx`
- Modify: `apps/web/src/pages/intraday/IntradayPage.tsx`, `apps/web/src/pages/swing/SwingPage.tsx`

**Interfaces — Consumes:** `GET /api/me/subscriptions` (Task 2); `useAuthStore` role.
**Produces:** `useSubscriptions(): { intraday: boolean; swing: boolean; loading: boolean }`.

- [ ] **Step 1:** In `anand.ts`, make provenance optional so sanitized payloads type-check and pages can branch:
```ts
export interface AnandEntry {
  id: string; symbol: string; token: string | null; entryPrice: number; enteredAt: string;
  targetPct: number; stopPct: number; status: string; exitPrice: number | null; exitedAt: string | null;
  currentPrice: number | null; pnlPct: number | null; targetLeftPct: number | null; priceStale?: boolean;
  segment?: 'INTRADAY' | 'SWING';
  // provenance — present only for ADMIN responses:
  scannerName?: string | null;
  scoreBreakdown?: Array<{ name: string; points: number; pointsPossible: number; passed: boolean }> | null;
  leadCount?: number; leadDates?: string[]; trailing?: boolean; exitReason?: string | null;
}
```
- [ ] **Step 2:** Create `useSubscriptions.ts` (poll once; mirror `useIntradayEntries` style):
```ts
import { useEffect, useState } from 'react';
import api from '../services/api';
export function useSubscriptions() {
  const [s, setS] = useState({ intraday: false, swing: false, loading: true });
  useEffect(() => { let on = true;
    api.get<{ INTRADAY: boolean; SWING: boolean }>('/me/subscriptions')
      .then(r => { if (on) setS({ intraday: r.data.INTRADAY, swing: r.data.SWING, loading: false }); })
      .catch(() => { if (on) setS({ intraday: false, swing: false, loading: false }); });
    return () => { on = false; };
  }, []);
  return s;
}
```
- [ ] **Step 3:** Create `SubscribeCard.tsx`:
```tsx
import toast from 'react-hot-toast';
export function SubscribeCard({ segment }: { segment: 'Intraday' | 'Swing' }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-8 text-center">
      <h2 className="text-lg font-semibold mb-2">Subscribe to {segment}</h2>
      <p className="text-sm text-[var(--color-text-muted)] mb-4">Get {segment} signals and auto-execution for your account.</p>
      <button className="rounded bg-blue-600 px-4 py-2 text-white" onClick={() => toast('Checkout coming soon')}>Subscribe</button>
    </div>
  );
}
```
- [ ] **Step 4:** In `IntradayPage.tsx` / `SwingPage.tsx`:
  - Add `const role = useAuthStore((s) => s.user?.role); const isAdmin = role === 'ADMIN'; const subs = useSubscriptions();`
  - **Gate:** if `!isAdmin && !subs.loading && !subs.intraday` (swing: `!subs.swing`) → `return <SubscribeCard segment="Intraday" />;` before fetching entries (move the `useIntradayEntries` call so it still runs unconditionally per hooks rules, but render the card early — or pass an `enabled` flag; simplest: render the card and let the gated 403 yield empty entries).
  - **Provenance UI:** wrap the Scanner column header/cell, the `ChartinkScoreTable` expand, the Leads column, and trailing/exitReason badges in `{isAdmin && ( … )}`.
- [ ] **Step 5:** Verify types + run existing page-related unit tests:
Run: `cd apps/web && npx tsc -b --noEmit && npx vitest run src/utils/swingOpenBook.spec.ts`
Expected: no type errors; existing tests pass.
- [ ] **Step 6: Commit** `TDA-007: sanitized Intraday/Swing UI + subscribe placeholder`.

---

### Task 7: Settings account hub (USER view)

**Files:**
- Modify: `apps/web/src/pages/settings/SettingsPage.tsx`

**Interfaces — Consumes:** `useAuthStore` (email, logout), `useSubscriptions` (Task 6).

- [ ] **Step 1: Implement** — for a non-ADMIN, render the account hub: Subscriptions (per-segment status from `useSubscriptions`, stub Subscribe button → `toast('Checkout coming soon')`), and placeholder cards for **Connect Angel One** (TDA-005), **Consent & disclaimer** (TDA-009), **Auto-execution** (disabled toggle, TDA-011), and **Account** (email + Logout). Each placeholder card states the capability and "Coming soon". Keep any existing ADMIN settings behind `{isAdmin && …}` or a role check so ADMIN keeps current behavior. (Code mirrors `SubscribeCard` styling; full JSX written by the implementer following that pattern — each card is a titled `<div>` with a muted description.)
- [ ] **Step 2: Verify** `cd apps/web && npx tsc -b --noEmit` → no errors.
- [ ] **Step 3: Commit** `TDA-007: Settings account hub for USER`.

---

### Task 8: E2E smoke (sanitized surface, gate, grant)

**Files:**
- Create: `apps/web/tests/e2e/user-surface.spec.ts` (Playwright; `test:e2e`)

**Context:** Requires the SaaS API (4101) + web (4100) running, and the seeded `viewer@panamoure.com` USER + an ADMIN. Use the running demo stack (or document the launch). The admin grant uses `POST /api/admin/subscriptions` with an ADMIN token.

- [ ] **Step 1: Write the E2E** — log in as `viewer@panamoure.com`; assert the sidebar shows exactly Intraday/Swing/Positions/Settings; open Swing → assert the Subscribe placeholder; via API (ADMIN token) grant SWING to the viewer; reload Swing → assert entries render AND assert the captured `/api/anand/swing/entries` response body contains no `scannerName`/`scoreBreakdown`. (Capture via `page.on('response')`.)
- [ ] **Step 2: Run** `cd apps/web && npx playwright test tests/e2e/user-surface.spec.ts` (start the 4100/4101 stack first — see the dual-run port scheme). Expected: PASS.
- [ ] **Step 3: Commit** `TDA-007: E2E smoke for sanitized user surface`.

---

## Self-Review

- Spec coverage: §3.1 nav→T4, route guard→T5; §4 sanitized pages→T6; §5.1 backend gate→T3, §5.2 placeholder→T6, §5.3 admin grant→T2; §6 Settings→T7; §1 SubscriptionService→T1; acceptance AC1→T4, AC2→T5, AC3→T6, AC4→T3, AC5→T2, AC6→T7; test plan E2E→T8. ✅
- **Type consistency:** `SubscriptionService` method signatures (`hasActive`/`listForUser`/`grant`/`revoke`, `Seg = 'INTRADAY'|'SWING'`) identical across T1/T2/T3; `{ INTRADAY: boolean; SWING: boolean }` shape from `listForUser` matches `useSubscriptions` mapping in T6; `NOT_SUBSCRIBED` body shape (`{code,segment}`) consistent T3↔T6. ✅
- **Dependency on TDA-006:** T3/T6 assume TDA-006 Task 2 already added `@CurrentUser()` + `toPublicEntry` to the anand handlers. **TDA-006 must merge before TDA-007 starts.** ✅ (noted; sequence S3 as 006→007.)
- **Hooks-rule risk (T6):** an early `return <SubscribeCard/>` before a `useIntradayEntries()` call violates React hook ordering. Fix: call all hooks first, branch in render only. Flagged in T6 Step 4. ✅
- **Tenant-scoping risk (T1):** `Subscription` is a TENANT_MODEL; admin grant/cross-user reads must use `runWithoutTenant`. Implemented in T1. ✅
- Placeholder scan: T7 leaves the card JSX to the implementer following an explicit pattern (acceptable — concrete styling shown in T6 `SubscribeCard`); no `TBD`/`handle edge cases`. ✅
- Deferred: real broker/consent/auto-exec/checkout/landing. ✅
