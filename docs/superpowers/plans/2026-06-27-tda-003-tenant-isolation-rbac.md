# TDA-003 Tenant Isolation & RBAC — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make tenant isolation structural — a request-scoped tenant context (AsyncLocalStorage via nestjs-cls) + a Prisma query interceptor that auto-scopes tenant-owned models for non-admin requests — plus a `RolesGuard`/`@Roles` for RBAC.

**Architecture:** `nestjs-cls` establishes a per-request store; a global `TenantContextInterceptor` (after `JwtAuthGuard`) sets `{ userId, role }` from `req.user`; `PrismaService.$use` reads the context and injects `userId` scoping on tenant-owned models. No context (cron/queue/engine) or `role=ADMIN` ⇒ unscoped. Spec: `docs/superpowers/specs/2026-06-27-tda-003-tenant-isolation-rbac-design.md`.

**Tech Stack:** NestJS 11, Prisma 6 (Postgres `td_saas`), `nestjs-cls`, Jest + ts-jest.

## Global Constraints

- **DB:** dev `td_saas`, tests `td_saas_test` (env `DATABASE_URL_TEST`, derive from `.env` `/td_saas`→`/td_saas_test`). Prisma from worktree root, `--schema prisma/schema.prisma`. `docker exec td-postgres psql -U <user-from-.env>`. Never `prisma migrate reset`. No schema migration is needed in this spec (no new columns) — but verify.
- **TENANT_MODELS (verbatim):** `Trade, UserSettings, DailyPerformance, Alert, AITradeAnalysis, AIWeeklyReport, BrokerCredential, Subscription, AutoTradeConsent, ConsentRecord, RefreshToken, VerificationToken`. `User` is NOT scoped. No global/IP model is scoped.
- **Bypass rule:** scope ONLY when a tenant context is active AND `role !== 'ADMIN'`. Absent context ⇒ unscoped (system/background). Fail safe: if a tenant-model write can't be scoped, throw.
- **findUnique gotcha:** rewrite findUnique/findUniqueOrThrow on tenant models to findFirst with the userId filter so another tenant's row returns null.
- **Guard order:** `JwtAuthGuard` then `RolesGuard` (both APP_GUARD); coexist with the existing `ThrottlerGuard`. `@Public` bypasses both.
- **Commit prefix:** `TDA-003:`. No `.env`. Stage only changed files (no `-A`).

---

## File Structure
- `apps/api/src/common/tenant/tenant-context.service.ts` — wraps cls get/set + `runWithoutTenant`.
- `apps/api/src/common/tenant/tenant-context.interceptor.ts` — sets context from `req.user`.
- `apps/api/src/common/tenant/tenant.constants.ts` — `TENANT_MODELS`.
- `apps/api/src/common/prisma/prisma.service.ts` — add the `$use` scoping middleware (modify).
- `apps/api/src/common/decorators/roles.decorator.ts` + `apps/api/src/modules/auth/guards/roles.guard.ts`.
- `apps/api/src/app.module.ts` — `ClsModule.forRoot` + register interceptor + `RolesGuard` APP_GUARD (modify).
- Tests under `apps/api/test/tda003/`.

---

### Task 1: Tenant context (nestjs-cls + interceptor + service)

**Files:** add `nestjs-cls` dep; create `tenant-context.service.ts`, `tenant-context.interceptor.ts`, `tenant.constants.ts`; wire `ClsModule.forRoot({ middleware: { mount: true } })` + interceptor in `app.module.ts`; test `apps/api/test/tda003/tenant-context.spec.ts`.

**Interfaces — Produces:**
- `TenantContextService.get(): { userId: string; role: string } | undefined`; `.set(ctx)`; `.runWithoutTenant<T>(fn: () => T): T`.
- `TenantContextInterceptor` (global) — after guards, if `req.user` present, `set({ userId: req.user.userId, role: req.user.role })`.

- [ ] **Step 1:** `pnpm --filter @td/api add nestjs-cls` (pure JS, no native build).
- [ ] **Step 2: Write the failing test** — bootstrap a tiny Nest app with ClsModule + a route guarded so `req.user` is faked; assert that inside the handler `TenantContextService.get()` returns the expected `{userId, role}`, and that on a route with no user it returns `undefined`. Also unit-test `runWithoutTenant` clears the value within an active context.
- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement** the service over `ClsService` (`@nestjs/cls`), the interceptor (reads `context.switchToHttp().getRequest().user`), `tenant.constants.ts`, and wire `ClsModule.forRoot({ middleware: { mount: true } })` + `{ provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor }` in `app.module.ts`.
- [ ] **Step 5: Run → PASS.**
- [ ] **Step 6: Commit** `TDA-003: request-scoped tenant context via nestjs-cls`.

---

### Task 2: Prisma tenant-scoping interceptor (security-critical)

**Files:** modify `prisma.service.ts` (inject `TenantContextService`, register `$use`); integration test `apps/api/test/tda003/isolation.spec.ts`. Consumes Task 1.

**Interfaces:** none new exported — behavior change on the shared `PrismaService`.

- [ ] **Step 1: Write the failing isolation tests** (run the client with a manually-set tenant context using `TenantContextService.runWith(...)` test helper, OR by wrapping calls in `cls.run`): seed two users A and B each with a `Trade`. Assert, as tenant A (non-admin):
  - `prisma.trade.findMany()` returns only A's; `findUnique({where:{id:Btrade}})` → `null`.
  - `update({where:{id:Btrade},...})`/`delete` affect 0 rows (or throw P2025) — B's row unchanged.
  - `create({ data: { ...Atrade, userId: B }})` persists with `userId === A` (context wins).
  - As `role=ADMIN`: `findMany()` returns BOTH users' trades.
  - With NO context: `findMany()` returns BOTH (background bypass).
  - `prisma.signal.findMany()` (global model) returns all rows in every context (never scoped).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the `$use` middleware in `onModuleInit` per spec §4: gate on `ctx && ctx.role!=='ADMIN' && TENANT_MODELS.has(params.model)`; handle read/update/delete (merge `AND:[{userId},...]`), findUnique→findFirst rewrite, create/createMany/upsert userId stamping; fail-safe throw on un-scopable tenant write. Inject `TenantContextService` into `PrismaService`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-003: auto-scope tenant-owned Prisma queries by userId`.

---

### Task 3: RolesGuard + @Roles + RBAC tests

**Files:** `common/decorators/roles.decorator.ts` (+ `@AdminOnly`), `modules/auth/guards/roles.guard.ts`, register as `APP_GUARD` after JwtAuthGuard in `app.module.ts`; integration test `apps/api/test/tda003/rbac.spec.ts`. Consumes TDA-002 `req.user`.

**Interfaces — Produces:** `@Roles(...roles)`, `@AdminOnly()`, `RolesGuard`.

- [ ] **Step 1: Write the failing test** — a test controller with an `@AdminOnly()` route and a plain authenticated route and a `@Public` route. Assert: USER token → admin route 403, plain route 200; ADMIN token → both 200; no token → admin/plain 401, public 200.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `@Roles` (SetMetadata), `RolesGuard` (Reflector reads handler+class; skip when `@Public`; allow when no `@Roles`; else require `req.user.role` in set → else `ForbiddenException`); register `{ provide: APP_GUARD, useClass: RolesGuard }` AFTER the JwtAuthGuard provider so it runs second.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-003: RBAC via @Roles + RolesGuard`.

---

## Self-Review
- Spec §3 context → T1; §4 scoping + findUnique gotcha + create stamping → T2; §5 runWithoutTenant → T1/T2; §6 RBAC → T3; §7 tests distributed across T1–T3. ✅
- No DB migration (no new columns) — confirm `prisma migrate status` is clean before/after.
- Deferred: frontend token wiring, fan-out (TDA-010), KMS (TDA-004/005). ✅
- Guard-order risk: RolesGuard must run after JwtAuthGuard (so `req.user` exists) — flagged in T3 Step 3.
- Background-safety risk: the no-context bypass (T2) is what keeps cron/queue/engine working — its test is mandatory, not optional.
