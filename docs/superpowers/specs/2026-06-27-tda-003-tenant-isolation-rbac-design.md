# TDA-003 — Tenant Isolation & RBAC

**Spec ID:** TDA-003 · **Sprint:** S1 · **Phase:** MVP
**Depends on:** TDA-001 (userId on tenant-owned models), TDA-002 (JwtAuthGuard, req.user with `{ userId, role }`)
**Blocks:** TDA-007, TDA-010, TDA-011 · **Date:** 2026-06-27 · **Status:** In design
**Parent:** [TDA-ROADMAP](./2026-06-27-production-rearchitecture-roadmap.md)

---

## 1. Goal

Make tenant data isolation **structural**, not a thing developers must remember. Two layers:
1. A request-scoped **tenant context** (the authenticated `userId` + `role`) propagated via
   AsyncLocalStorage.
2. A **Prisma query interceptor** that auto-injects `where: { userId }` (and `data.userId` on
   create) for every tenant-owned model whenever a non-admin tenant context is active — so an
   unscoped query on user data is impossible to write by accident.

Plus **RBAC**: a `@Roles()` decorator + `RolesGuard` to gate admin-only routes (the engine,
provenance, cross-tenant ops).

**Out of scope:** rewriting existing controllers/services (the interceptor secures their
queries automatically); the centralized signal fan-out (TDA-010); wiring the React frontend to
send tokens (separate later task). KMS/secrets (TDA-004/005).

## 2. The central risk this addresses

The most common multi-tenant breach is a missing `WHERE user_id = ?` → "user A sees user B's
trades." We defeat it by making the filter automatic and the bypass explicit, rather than
trusting every query site.

## 3. Tenant context (AsyncLocalStorage)

Use **`nestjs-cls`** (pure JS, no native build) for robust request-scoped storage that survives
guards → interceptors → handlers → async work.

- `ClsModule.forRoot({ middleware: { mount: true } })` in `app.module.ts` establishes a CLS
  store per HTTP request (mounted as middleware, so the store exists before guards run).
- A global **`TenantContextInterceptor`** (runs after `JwtAuthGuard`) reads `req.user` and, when
  present, sets `cls.set('tenant', { userId, role })`. Public/unauthenticated routes leave it
  unset.
- A thin **`TenantContextService`** wraps `cls.get('tenant')` / a `runWithoutTenant(fn)` escape
  hatch (see §5) so non-HTTP code (cron, Bull workers, the engine) and admin ops can run
  unscoped deliberately.

**Key invariant:** "no tenant context" ≠ "deny" — it means **system/background scope (unscoped)**.
HTTP requests for authenticated users always carry context; cron/queue/engine code never does,
so it keeps full cross-tenant/global access (it must, to run the shared engine).

## 4. Prisma tenant-scoping interceptor

In `PrismaService.onModuleInit`, register a query interceptor (`this.$use(...)` middleware;
acceptable on Prisma 6.x — note a future migration to client-extension `query` components).
`PrismaService` gets `TenantContextService` injected.

```
TENANT_MODELS = { Trade, UserSettings, DailyPerformance, Alert, AITradeAnalysis,
                  AIWeeklyReport, BrokerCredential, Subscription, AutoTradeConsent,
                  ConsentRecord, RefreshToken, VerificationToken }   // every model with a userId scalar
```
(`User` is NOT in the set — it is the tenant root, keyed by `id`; services query it by the
authenticated id explicitly, e.g. `/auth/me`.)

Logic per query, ONLY when a tenant context is active AND `role !== 'ADMIN'` AND
`model ∈ TENANT_MODELS`:
- **read/aggregate/update/delete (findFirst/findMany/update/updateMany/delete/deleteMany/count/aggregate):**
  merge `AND: [{ userId: ctx.userId }, <existing where>]`.
- **findUnique / findUniqueOrThrow:** these accept only unique fields, so a `userId` filter
  can't be added directly. Rewrite the action to `findFirst` with the merged `userId` filter
  (the classic gotcha — a row belonging to another tenant must return `null`, never the row).
- **create:** set `data.userId = ctx.userId` (override any client-supplied userId).
- **createMany:** stamp `userId` on each row.
- **upsert:** scope the `where` (via findFirst-style) and stamp `create.userId`.

When the context is absent (system/background) or `role === 'ADMIN'`, pass through unchanged.

> Security note: the interceptor is the single source of truth. It must fail safe — if it
> cannot determine how to scope a tenant-model write, it throws rather than running unscoped.

## 5. Explicit bypass (system scope)

`TenantContextService.runWithoutTenant(fn)` runs `fn` with the tenant context cleared (even
inside an HTTP request) for the rare, audited case where an authenticated admin action must
touch another tenant. Background jobs simply never set context, so they need no wrapper.
Document every call site.

## 6. RBAC

- `@Roles(...roles: UserRole[])` decorator (metadata).
- `RolesGuard` (global `APP_GUARD`, ordered AFTER `JwtAuthGuard`): if a handler/class declares
  `@Roles`, require `req.user.role` ∈ the set, else 403. No `@Roles` → allowed for any
  authenticated user. `@Public` routes skip it.
- Provide an `@AdminOnly()` shorthand = `@Roles('ADMIN')`.

## 7. Tests (integration, td_saas_test)

Isolation is the crux — prove it directly by simulating two tenants:
1. **Read isolation:** with tenant context = user A, `prisma.trade.findMany()` returns ONLY A's
   trades; a `findUnique({ where: { id: <B's trade id> } })` returns `null`.
2. **Write isolation:** user A `update`/`delete` targeting B's trade id affects 0 rows; `create`
   stamps `userId = A` even if the payload tries `userId: B`.
3. **Admin bypass:** tenant context with `role=ADMIN` sees all tenants' rows.
4. **No-context bypass:** with no tenant set (background), queries are unscoped (see all) — proves
   the engine/cron keep working.
5. **Global model untouched:** `Signal`/`Candle` queries are never scoped in any context.
6. **runWithoutTenant:** clears scoping inside an active context.
7. **RBAC:** a `@Roles('ADMIN')` route returns 403 for a USER token, 200 for an ADMIN token;
   a route with no `@Roles` allows any authenticated user; `@Public` route needs no token.

## 8. Acceptance criteria

- A USER request can never read, update, or delete another user's tenant-owned rows (proven by
  tests), including via `findUnique`.
- `create` always stamps the context userId.
- ADMIN and background/system code retain full access; global/IP models are never scoped.
- `RolesGuard` enforces `@Roles`; coexists with `JwtAuthGuard` + `ThrottlerGuard`.
- The existing app still boots; engine/cron paths (no context) are unaffected.
- `prisma validate` clean; integration tests green against `td_saas_test`.
