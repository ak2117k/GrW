# TDA-017 USER UX Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a user-facing UX overhaul — a Payments history page (real ledger), a user Dashboard (their executed-trade performance + Angel One management), a card/feed redesign of Intraday/Swing, and a tasteful CSS-3D depth system across all pages incl. landing — as one coordinated release.

**Architecture:** Backend adds one tenant-owned `Payment` model populated by the existing Razorpay webhook and served by a new `/api/me/billing/payments` endpoint; everything else is frontend consuming existing tenant-scoped APIs. Built by a 6-agent team in two waves (foundations → pages) with a serialized nav/route integration step to avoid collisions on shared files.

**Tech Stack:** NestJS + Prisma (Postgres `td_saas`), React + Vite + TypeScript, Tailwind v4 (`@theme` in `app.css`), Zustand, Jest (backend, Style-B scratch DB), Vitest (frontend pure-logic).

## Global Constraints

- Paper mode only — `LIVE_TRADING_ENABLED=false`; no live broker calls in any task.
- No WebGL/three.js — depth is **CSS transforms only**; every effect gated behind `@media (prefers-reduced-motion: reduce)`.
- Provenance boundary (TDA-006) is inviolable — the USER render path must never emit `scanner`, `scoreBreakdown`, `trailing`, or `exitReason`. ADMIN-only fields render only inside an ADMIN-gated branch.
- Money is stored in **paise (integer minor units)**, never floats.
- Migrations are **hand-authored** and applied via `prisma migrate deploy` (repo-wide `migrate dev --create-only` shadow-DB replay bug); number the new migration AFTER the latest existing one.
- Tenant-owned models are queried through the tenant-scoped `PrismaService`; cross-user/worker writes use `TenantContextService.runWithoutTenant`.
- Backend tests: Style-B against a scratch DB `td_saas_tda017`; mirror `test/tda015/jest.config.js`. Never run `prisma migrate reset`.
- No secrets/PII in logs or audit meta (tda004 no-secret-leak guard still applies).
- No browser-driving — the user verifies UI themselves.
- Nothing is committed until the whole-branch review passes; the release is a SINGLE commit + push at the end.
- All subagents dispatched on the **opus** model.

## File Structure

**Backend (Agent A):**
- Modify `prisma/schema.prisma` — add `Payment` model, `PaymentStatus` enum, `Payment[]` relation on `User`.
- Create `prisma/migrations/<ts>_tda017_payments/migration.sql` — hand-authored.
- Modify `apps/api/src/modules/billing/providers/payment-provider.interface.ts` — extend `BillingEvent` + `normalizeRazorpayEnvelope`.
- Create `apps/api/src/modules/billing/payment.service.ts` — `record()` + `listForUser()`.
- Modify `apps/api/src/modules/billing/billing-webhook.service.ts` — call `PaymentService.record()` on charged/failed.
- Modify `apps/api/src/modules/billing/billing.module.ts` — provide `PaymentService`.
- Modify `apps/api/src/modules/billing/me-billing.controller.ts` — add `GET payments`.
- Create `apps/api/test/tda017/{jest.config.js,otplib.stub.js,payments.spec.ts}`.

**Frontend depth/shared (Agent B):**
- Modify `apps/web/src/app.css` — depth tokens + `.depth-card`/`.glass-panel` utilities + reduced-motion guard.
- Create `apps/web/src/components/depth/TiltCard.tsx`, `tilt.ts`, `ParallaxHero.tsx`, `index.ts`.
- Create `apps/web/src/components/depth/tilt.spec.ts`.
- Create `apps/web/src/components/broker/ConnectAngelOne.tsx` (extracted) + `index.ts`.
- Modify `apps/web/src/pages/settings/SettingsPage.tsx` — import shared `ConnectAngelOne`.
- Create `apps/web/src/components/signals/SignalCard.tsx`, `SignalSummaryStrip.tsx`, `signal-card.ts`, `index.ts`.
- Create `apps/web/src/components/signals/signal-card.spec.ts`.

**Frontend pages (Agents C–F):**
- Create `apps/web/src/hooks/usePayments.ts` + `usePayments.spec.ts`, `apps/web/src/pages/payments/PaymentsPage.tsx`.
- Create `apps/web/src/hooks/useDashboard.ts` + `useDashboard.spec.ts`, `apps/web/src/pages/dashboard/UserDashboardPage.tsx`.
- Modify `apps/web/src/pages/intraday/IntradayPage.tsx`, `apps/web/src/pages/swing/SwingPage.tsx`.
- Modify `apps/web/src/pages/landing/LandingPage.tsx`.

**Integration (serialized):**
- Modify `apps/web/src/App.tsx`, `apps/web/src/components/layout/navItems.ts`.

---

# WAVE 1 — Foundations (Agents A & B, parallel)

## Task 1: Payment model + migration (Agent A)

**Files:**
- Modify: `prisma/schema.prisma` (Payment model + enum + User relation)
- Create: `prisma/migrations/20260704120000_tda017_payments/migration.sql`

**Interfaces:**
- Produces: Prisma model `Payment { id, userId, segment?, amount:Int, currency, status:PaymentStatus, providerPaymentId @unique, providerInvoiceId?, invoiceUrl?, description?, createdAt }`; enum `PaymentStatus { CAPTURED FAILED REFUNDED }`.

- [ ] **Step 1: Add the model + enum to the schema**

In `prisma/schema.prisma`, after the `WebhookEvent` model (near line 1503), add:

```prisma
// TDA-017 — per-transaction payment ledger. Tenant-owned (userId). Written by
// the billing webhook worker (runWithoutTenant, cross-user); read by the user
// via the tenant-scoped /api/me/billing/payments endpoint. Idempotent on
// providerPaymentId (a redelivered payment.captured is a no-op upsert).
model Payment {
  id                String        @id @default(cuid())
  userId            String
  user              User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  segment           Segment?      // null for account-level charges
  amount            Int           // minor units (paise)
  currency          String        @default("INR")
  status            PaymentStatus
  providerPaymentId String        @unique  // razorpay payment id — idempotency key
  providerInvoiceId String?
  invoiceUrl        String?
  description       String?
  createdAt         DateTime      @default(now())
  @@index([userId, createdAt])
  @@map("payments")
}

enum PaymentStatus {
  CAPTURED
  FAILED
  REFUNDED
}
```

- [ ] **Step 2: Add the relation on User**

Find `model User {` in `prisma/schema.prisma`. Alongside its other relation fields (e.g. near the `Subscription`/`BillingProfile` back-relations), add:

```prisma
  payments          Payment[]
```

- [ ] **Step 3: Hand-author the migration SQL**

Create `prisma/migrations/20260704120000_tda017_payments/migration.sql`:

```sql
-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CAPTURED', 'FAILED', 'REFUNDED');

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "segment" "Segment",
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "PaymentStatus" NOT NULL,
    "providerPaymentId" TEXT NOT NULL,
    "providerInvoiceId" TEXT,
    "invoiceUrl" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_providerPaymentId_key" ON "payments"("providerPaymentId");
CREATE INDEX "payments_userId_createdAt_idx" ON "payments"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 4: Apply the migration and regenerate the client**

Run from repo root:
```bash
npx prisma migrate deploy --schema prisma/schema.prisma
npx prisma generate --schema prisma/schema.prisma
```
Expected: `migrate deploy` reports `1 migration applied` (`20260704120000_tda017_payments`); `generate` succeeds (an EPERM on `query_engine-windows.dll.node` is benign — retry once if a node process holds it).

- [ ] **Step 5: Verify the table exists**

Run:
```bash
docker exec td-postgres psql -U postgres -d td_saas -c "\d payments"
```
Expected: table `payments` with the columns above and the unique index on `providerPaymentId`.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260704120000_tda017_payments/
git commit -m "TDA-017: Payment ledger model + migration"
```

## Task 2: Surface amount + payment id on BillingEvent (Agent A)

**Files:**
- Modify: `apps/api/src/modules/billing/providers/payment-provider.interface.ts`
- Create: `apps/api/test/tda017/jest.config.js`, `apps/api/test/tda017/otplib.stub.js`
- Test: `apps/api/test/tda017/normalize-payment.spec.ts`

**Interfaces:**
- Consumes: existing `normalizeRazorpayEnvelope(rawBody: Buffer): BillingEvent`.
- Produces: `BillingEvent` gains `providerPaymentId?: string` and `amount?: number` (paise); the normalizer populates both from `payload.payment.entity.{id,amount}`.

- [ ] **Step 1: Create the tda017 jest config + otplib stub**

Create `apps/api/test/tda017/jest.config.js`:
```js
const path = require('path');

/**
 * Standalone Jest config for TDA-017 (payments). Mirrors test/tda015: roots at
 * test/tda017, rootDir at apps/api so ts-jest reads apps/api/tsconfig.json.
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_tda017 \
 *     npx jest --config test/tda017/jest.config.js --runInBand --verbose
 */
module.exports = {
  rootDir: path.resolve(__dirname, '../..'),
  roots: ['<rootDir>/test/tda017'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  moduleNameMapper: {
    '^otplib$': '<rootDir>/test/tda017/otplib.stub.js',
  },
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { isolatedModules: true, tsconfig: { allowJs: true } }],
  },
  testEnvironment: 'node',
};
```

Create `apps/api/test/tda017/otplib.stub.js`:
```js
// Inert CJS stub — MFA is never exercised in TDA-017 tests (mirrors tda015).
module.exports = { authenticator: { generate: () => '000000', check: () => true } };
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/test/tda017/normalize-payment.spec.ts`:
```ts
import { normalizeRazorpayEnvelope } from '../../src/modules/billing/providers/payment-provider.interface';

function charged(paymentId: string, amount: number): Buffer {
  return Buffer.from(
    JSON.stringify({
      event: 'subscription.charged',
      created_at: 1_700_000_100,
      payload: {
        subscription: { entity: { id: 'sub_1', current_end: 1_700_003_600 } },
        payment: { entity: { id: paymentId, amount } },
      },
    }),
  );
}

describe('normalizeRazorpayEnvelope — payment fields', () => {
  it('surfaces providerPaymentId and amount (paise) from the payment entity', () => {
    const ev = normalizeRazorpayEnvelope(charged('pay_abc', 49900));
    expect(ev.kind).toBe('PAYMENT_CHARGED');
    expect(ev.providerPaymentId).toBe('pay_abc');
    expect(ev.amount).toBe(49900);
  });

  it('leaves payment fields undefined when there is no payment entity', () => {
    const ev = normalizeRazorpayEnvelope(
      Buffer.from(JSON.stringify({ event: 'subscription.activated', payload: { subscription: { entity: { id: 'sub_1' } } } })),
    );
    expect(ev.providerPaymentId).toBeUndefined();
    expect(ev.amount).toBeUndefined();
  });
});
```

- [ ] **Step 2b: Run test to verify it fails**

Run from `apps/api`:
```bash
npx jest --config test/tda017/jest.config.js normalize-payment --runInBand
```
Expected: FAIL — `ev.providerPaymentId` is `undefined` (field not yet surfaced).

- [ ] **Step 3: Extend the interface + normalizer**

In `payment-provider.interface.ts`, add two fields to `BillingEvent` (after `currentPeriodEnd?`):
```ts
  /** Provider payment id for the charge/failure (Payment idempotency key). */
  providerPaymentId?: string;
  /** Charged amount in minor units (paise). */
  amount?: number;
```

In `normalizeRazorpayEnvelope`, widen the parsed `payment.entity` type and populate the fields. Change the `payment` shape in the `parsed` type to `payment?: { entity?: { id?: string; amount?: number } }`, then before the `return`:
```ts
  const paymentEntity = parsed.payload?.payment?.entity;
  const paymentId = paymentEntity?.id;
```
and add to the returned object:
```ts
    providerPaymentId: paymentId,
    amount: typeof paymentEntity?.amount === 'number' ? paymentEntity.amount : undefined,
```
(Keep the existing `eventId` derivation using `paymentId` — it already reads the same value.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --config test/tda017/jest.config.js normalize-payment --runInBand`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/billing/providers/payment-provider.interface.ts apps/api/test/tda017/
git commit -m "TDA-017: surface providerPaymentId + amount on BillingEvent"
```

## Task 3: PaymentService.record + webhook capture (Agent A)

**Files:**
- Create: `apps/api/src/modules/billing/payment.service.ts`
- Modify: `apps/api/src/modules/billing/billing-webhook.service.ts`, `apps/api/src/modules/billing/billing.module.ts`
- Test: `apps/api/test/tda017/payments.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `TenantContextService`; `BillingEvent` (with `providerPaymentId`, `amount`); resolved `{ userId, segment }` from `BillingService.resolveByProviderSubId`.
- Produces: `PaymentService.record(input: { userId; segment: Seg|null; amount: number; status: 'CAPTURED'|'FAILED'|'REFUNDED'; providerPaymentId: string; description?: string }): Promise<void>` (idempotent upsert on `providerPaymentId`); `PaymentService.listForUser(userId: string): Promise<PaymentView[]>` where `PaymentView = { id; segment: string|null; amount: number; currency: string; status: string; providerPaymentId: string; invoiceUrl: string|null; description: string|null; createdAt: string }`.

- [ ] **Step 1: Write the failing test (idempotent record)**

Create `apps/api/test/tda017/payments.spec.ts`:
```ts
import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { PaymentService } from '../../src/modules/billing/payment.service';

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error('DATABASE_URL_TEST must point at the scratch td_saas_tda017 DB');
process.env.DATABASE_URL = url;

const raw = new PrismaClient({ datasources: { db: { url } } });
const cls = new ClsService(new AsyncLocalStorage());
const tenant = new TenantContextService(cls);
const prisma = new PrismaService(tenant);
const payments = new PaymentService(prisma, tenant);
const run = <T>(fn: () => Promise<T>): Promise<T> => cls.run(() => fn());

let uId: string;
let otherId: string;

beforeAll(async () => {
  await prisma.onModuleInit();
  const u = await raw.user.create({ data: { email: 'tda017-pay@test.local', passwordHash: 'x', role: 'USER', status: 'ACTIVE' } });
  const o = await raw.user.create({ data: { email: 'tda017-other@test.local', passwordHash: 'x', role: 'USER', status: 'ACTIVE' } });
  uId = u.id; otherId = o.id;
});
afterAll(async () => {
  await raw.payment.deleteMany({ where: { userId: { in: [uId, otherId] } } });
  await raw.user.deleteMany({ where: { id: { in: [uId, otherId] } } });
  await raw.$disconnect();
  await prisma.$disconnect?.();
});

it('records a captured payment and is idempotent on providerPaymentId', async () => {
  await payments.record({ userId: uId, segment: 'INTRADAY', amount: 49900, status: 'CAPTURED', providerPaymentId: 'pay_dup', description: 'Intraday' });
  await payments.record({ userId: uId, segment: 'INTRADAY', amount: 49900, status: 'CAPTURED', providerPaymentId: 'pay_dup', description: 'Intraday' });
  const rows = await raw.payment.findMany({ where: { userId: uId, providerPaymentId: 'pay_dup' } });
  expect(rows).toHaveLength(1);
  expect(rows[0].amount).toBe(49900);
  expect(rows[0].status).toBe('CAPTURED');
});

it('listForUser returns only the caller rows, newest first', async () => {
  await payments.record({ userId: uId, segment: 'SWING', amount: 99900, status: 'CAPTURED', providerPaymentId: 'pay_u2' });
  await payments.record({ userId: otherId, segment: 'SWING', amount: 12300, status: 'CAPTURED', providerPaymentId: 'pay_other' });
  const mine = await run(() => payments.listForUser(uId));
  expect(mine.every((p) => p.providerPaymentId !== 'pay_other')).toBe(true);
  expect(mine.length).toBeGreaterThanOrEqual(2);
  const times = mine.map((p) => new Date(p.createdAt).getTime());
  expect(times).toEqual([...times].sort((a, b) => b - a));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `apps/api` (create the scratch DB first if missing):
```bash
docker exec td-postgres psql -U postgres -c "CREATE DATABASE td_saas_tda017" 2>/dev/null; \
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_tda017 npx prisma migrate deploy --schema ../../prisma/schema.prisma; \
DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_tda017 npx jest --config test/tda017/jest.config.js payments --runInBand
```
Expected: FAIL — cannot find module `payment.service` (not yet created).

- [ ] **Step 3: Create PaymentService**

Create `apps/api/src/modules/billing/payment.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { Seg } from './billing.service';

export interface PaymentView {
  id: string;
  segment: string | null;
  amount: number;
  currency: string;
  status: string;
  providerPaymentId: string;
  invoiceUrl: string | null;
  description: string | null;
  createdAt: string;
}

/**
 * TDA-017 — the per-transaction payment ledger. `record` is called by the
 * billing webhook worker (no tenant context) → runWithoutTenant; idempotent on
 * providerPaymentId (a redelivered charge is a no-op). `listForUser` serves the
 * authenticated /api/me/billing/payments surface.
 */
@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  async record(input: {
    userId: string;
    segment: Seg | null;
    amount: number;
    status: 'CAPTURED' | 'FAILED' | 'REFUNDED';
    providerPaymentId: string;
    providerInvoiceId?: string | null;
    invoiceUrl?: string | null;
    description?: string | null;
  }): Promise<void> {
    await this.tenant.runWithoutTenant(async () => {
      try {
        await this.prisma.payment.create({
          data: {
            userId: input.userId,
            segment: input.segment ?? null,
            amount: input.amount,
            status: input.status,
            providerPaymentId: input.providerPaymentId,
            providerInvoiceId: input.providerInvoiceId ?? null,
            invoiceUrl: input.invoiceUrl ?? null,
            description: input.description ?? null,
          },
        });
      } catch (err) {
        // Idempotent: a duplicate providerPaymentId (redelivered webhook) is a no-op.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
        throw err;
      }
    });
  }

  async listForUser(userId: string): Promise<PaymentView[]> {
    const rows = await this.prisma.payment.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      segment: r.segment,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      providerPaymentId: r.providerPaymentId,
      invoiceUrl: r.invoiceUrl,
      description: r.description,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
```

- [ ] **Step 4: Provide PaymentService in the module**

In `apps/api/src/modules/billing/billing.module.ts`, add `PaymentService` to the `providers` array (and `exports` if the module exports providers). Import it at the top:
```ts
import { PaymentService } from './payment.service';
```

- [ ] **Step 5: Wire the webhook to record payments**

In `billing-webhook.service.ts`:
1. Constructor-inject `private readonly payments: PaymentService` (import from `./payment.service`).
2. In `applyEvent`, in the `case 'PAYMENT_CHARGED':` branch (which shares with `SUBSCRIPTION_ACTIVATED`), after `grantAccess`, record a captured payment when a payment id is present:
```ts
        if (ev.kind === 'PAYMENT_CHARGED' && ev.providerPaymentId) {
          await this.payments.record({
            userId,
            segment,
            amount: ev.amount ?? 0,
            status: 'CAPTURED',
            providerPaymentId: ev.providerPaymentId,
            description: `${segment} subscription`,
          });
        }
```
3. In the `case 'PAYMENT_FAILED':` branch (shared with `PAYMENT_PENDING`), after `setGraceUntil`, record a failed payment only for the FAILED kind with a payment id:
```ts
        if (ev.kind === 'PAYMENT_FAILED' && ev.providerPaymentId) {
          await this.payments.record({
            userId,
            segment,
            amount: ev.amount ?? 0,
            status: 'FAILED',
            providerPaymentId: ev.providerPaymentId,
            description: `${segment} renewal failed`,
          });
        }
```

- [ ] **Step 6: Run the record test to verify it passes**

Run from `apps/api`:
```bash
DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_tda017 npx jest --config test/tda017/jest.config.js payments --runInBand
```
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/billing/payment.service.ts apps/api/src/modules/billing/billing-webhook.service.ts apps/api/src/modules/billing/billing.module.ts apps/api/test/tda017/payments.spec.ts
git commit -m "TDA-017: PaymentService + webhook records captured/failed payments"
```

## Task 4: GET /api/me/billing/payments (Agent A)

**Files:**
- Modify: `apps/api/src/modules/billing/me-billing.controller.ts`
- Test: `apps/api/test/tda017/payments-route.spec.ts`

**Interfaces:**
- Consumes: `PaymentService.listForUser`.
- Produces: `GET /api/me/billing/payments` → `PaymentView[]` for the authenticated user.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/tda017/payments-route.spec.ts` — construct the controller directly with a stub service and assert it delegates with the authenticated user's id:
```ts
import { MeBillingController } from '../../src/modules/billing/me-billing.controller';

it('GET payments returns the caller payments from the service', async () => {
  const listForUser = jest.fn().mockResolvedValue([{ id: 'p1', providerPaymentId: 'pay_1' }]);
  const controller = new MeBillingController({} as never, { listForUser } as never);
  const res = await controller.payments({ userId: 'usr_1', email: 'a@b.c' } as never);
  expect(listForUser).toHaveBeenCalledWith('usr_1');
  expect(res).toEqual([{ id: 'p1', providerPaymentId: 'pay_1' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_tda017 npx jest --config test/tda017/jest.config.js payments-route --runInBand`
Expected: FAIL — `controller.payments` is not a function / constructor arity mismatch.

- [ ] **Step 3: Add the endpoint**

In `me-billing.controller.ts`: import `PaymentService` + `PaymentView`, inject it as a second constructor param, and add:
```ts
  /** The authenticated user's payment history, newest first (TDA-017). */
  @Get('payments')
  payments(@CurrentUser() user: AuthenticatedUser): Promise<PaymentView[]> {
    return this.payments.listForUser(user.userId);
  }
```
Constructor becomes:
```ts
  constructor(
    private readonly billing: BillingService,
    private readonly payments: PaymentService,
  ) {}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_tda017 npx jest --config test/tda017/jest.config.js payments-route --runInBand`
Expected: PASS.

- [ ] **Step 5: Verify the whole tda017 suite + backend build**

Run from `apps/api`:
```bash
DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_tda017 npx jest --config test/tda017/jest.config.js --runInBand
npx nest build
```
Expected: all tda017 specs PASS; `nest build` (SWC) succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/billing/me-billing.controller.ts apps/api/test/tda017/payments-route.spec.ts
git commit -m "TDA-017: GET /api/me/billing/payments endpoint"
```

## Task 5: Depth CSS tokens + utilities (Agent B)

**Files:**
- Modify: `apps/web/src/app.css`

**Interfaces:**
- Produces: CSS custom props `--elev-1..--elev-3`, `--depth-perspective`; utility classes `.depth-card`, `.glass-panel`, `.depth-rise`; a global `prefers-reduced-motion` guard that neutralizes transforms/transitions.

- [ ] **Step 1: Add depth tokens to `:root` and the light override**

In `app.css`, inside the `:root { … }` block (after `--grid-line`), add:
```css
  --elev-1: 0 1px 2px rgba(3, 7, 18, 0.30), 0 2px 8px rgba(3, 7, 18, 0.22);
  --elev-2: 0 4px 12px rgba(3, 7, 18, 0.38), 0 12px 32px rgba(3, 7, 18, 0.30);
  --elev-3: 0 8px 24px rgba(3, 7, 18, 0.45), 0 24px 60px rgba(3, 7, 18, 0.38);
  --depth-perspective: 900px;
```
Inside `[data-theme="light"] { … }` (after `--grid-line`), add the lighter shadows:
```css
  --elev-1: 0 1px 2px rgba(16, 23, 51, 0.08), 0 2px 8px rgba(16, 23, 51, 0.06);
  --elev-2: 0 4px 12px rgba(16, 23, 51, 0.10), 0 12px 32px rgba(16, 23, 51, 0.08);
  --elev-3: 0 8px 24px rgba(16, 23, 51, 0.12), 0 24px 60px rgba(16, 23, 51, 0.10);
```

- [ ] **Step 2: Add the utility classes at the end of `app.css`**

```css
/* TDA-017 — depth/motion system. CSS transforms only; see reduced-motion guard. */
.glass-panel {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  backdrop-filter: blur(14px) saturate(1.1);
  -webkit-backdrop-filter: blur(14px) saturate(1.1);
  box-shadow: var(--elev-1);
  border-radius: 1rem;
}
.depth-card {
  box-shadow: var(--elev-2);
  transition: transform 0.25s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.25s ease;
  will-change: transform;
}
.depth-rise:hover {
  transform: translateY(-4px);
  box-shadow: var(--elev-3);
}

@media (prefers-reduced-motion: reduce) {
  .depth-card, .depth-rise:hover { transition: none; transform: none; }
  *, *::before, *::after { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; }
}
```

- [ ] **Step 3: Verify the web build compiles the CSS**

Run from `apps/web`:
```bash
npx vite build
```
Expected: build succeeds (CSS is valid; no unknown-at-rule errors).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app.css
git commit -m "TDA-017: depth tokens + glass/depth utilities + reduced-motion guard"
```

## Task 6: TiltCard component (Agent B)

**Files:**
- Create: `apps/web/src/components/depth/tilt.ts`, `apps/web/src/components/depth/TiltCard.tsx`, `apps/web/src/components/depth/index.ts`
- Test: `apps/web/src/components/depth/tilt.spec.ts`

**Interfaces:**
- Produces: `computeTilt(px: number, py: number, max?: number): { rotateX: number; rotateY: number }` (pure; `px`,`py` are 0..1 pointer position within the element; returns degrees, clamped to ±`max`, default 8); `<TiltCard className?, style?, maxTiltDeg?, children>` — a `div` applying pointer-tracked 3D tilt via `transform`, disabled under reduced-motion.

- [ ] **Step 1: Write the failing test for `computeTilt`**

Create `apps/web/src/components/depth/tilt.spec.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { computeTilt } from './tilt';

describe('computeTilt', () => {
  it('is neutral at the center', () => {
    expect(computeTilt(0.5, 0.5)).toEqual({ rotateX: 0, rotateY: 0 });
  });
  it('tilts toward the pointer within ±max', () => {
    const tl = computeTilt(0, 0, 8);
    expect(tl.rotateX).toBeCloseTo(8);   // pointer at top → positive X rotation
    expect(tl.rotateY).toBeCloseTo(-8);  // pointer at left → negative Y rotation
    const br = computeTilt(1, 1, 8);
    expect(br.rotateX).toBeCloseTo(-8);
    expect(br.rotateY).toBeCloseTo(8);
  });
  it('clamps to the provided max', () => {
    const { rotateX, rotateY } = computeTilt(0, 1, 5);
    expect(Math.abs(rotateX)).toBeLessThanOrEqual(5);
    expect(Math.abs(rotateY)).toBeLessThanOrEqual(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `apps/web`: `npx vitest run src/components/depth/tilt.spec.ts`
Expected: FAIL — cannot resolve `./tilt`.

- [ ] **Step 3: Implement `tilt.ts`**

```ts
/** Pure tilt math. px/py are 0..1 pointer coords within the element; returns
 *  rotation in degrees, clamped to ±max. Center (0.5,0.5) → no tilt. */
export function computeTilt(px: number, py: number, max = 8): { rotateX: number; rotateY: number } {
  const clamp = (v: number) => Math.max(-max, Math.min(max, v));
  // top (py=0) tilts the card back → +rotateX; left (px=0) → -rotateY.
  const rotateX = clamp((0.5 - py) * 2 * max);
  const rotateY = clamp((px - 0.5) * 2 * max);
  return { rotateX, rotateY };
}
```

- [ ] **Step 4: Implement `TiltCard.tsx`**

```tsx
import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { computeTilt } from './tilt';

interface TiltCardProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  maxTiltDeg?: number;
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** A pointer-tracked 3D-tilt wrapper. Pure CSS transforms; no-op when the user
 *  prefers reduced motion. Wrap depth content (a .depth-card) as children. */
export function TiltCard({ children, className, style, maxTiltDeg = 8 }: TiltCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [t, setT] = useState({ rotateX: 0, rotateY: 0 });

  const onMove = (e: React.MouseEvent) => {
    if (prefersReducedMotion() || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setT(computeTilt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, maxTiltDeg));
  };
  const reset = () => setT({ rotateX: 0, rotateY: 0 });

  return (
    <div
      ref={ref}
      onMouseMove={onMove}
      onMouseLeave={reset}
      style={{ perspective: 'var(--depth-perspective)', ...style }}
      className={className}
    >
      <div
        style={{
          transform: `rotateX(${t.rotateX}deg) rotateY(${t.rotateY}deg)`,
          transition: 'transform 0.15s ease-out',
          transformStyle: 'preserve-3d',
        }}
      >
        {children}
      </div>
    </div>
  );
}
```

Create `apps/web/src/components/depth/index.ts`:
```ts
export { TiltCard } from './TiltCard';
export { ParallaxHero } from './ParallaxHero';
export { computeTilt } from './tilt';
```
(`ParallaxHero` is added in Task 7; if executing strictly in order, add its export then.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/components/depth/tilt.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/depth/
git commit -m "TDA-017: TiltCard + pure tilt math"
```

## Task 7: ParallaxHero component (Agent B)

**Files:**
- Create: `apps/web/src/components/depth/ParallaxHero.tsx`
- Modify: `apps/web/src/components/depth/index.ts` (export it)

**Interfaces:**
- Produces: `<ParallaxHero className?, children>` — a pointer-parallax container that offsets its layered children via a CSS variable `--parallax` (per-layer depth via `data-depth`), disabled under reduced-motion.

- [ ] **Step 1: Implement `ParallaxHero.tsx`**

```tsx
import { useRef, type ReactNode } from 'react';

interface ParallaxHeroProps {
  children: ReactNode;
  className?: string;
}

/** Pointer-parallax hero. Children set `data-depth="0.2"` etc.; this maps
 *  pointer position to per-layer translate via inline transform on move.
 *  No-op under prefers-reduced-motion. */
export function ParallaxHero({ children, className }: ParallaxHeroProps) {
  const ref = useRef<HTMLDivElement>(null);

  const onMove = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const r = el.getBoundingClientRect();
    const dx = (e.clientX - r.left) / r.width - 0.5;
    const dy = (e.clientY - r.top) / r.height - 0.5;
    el.querySelectorAll<HTMLElement>('[data-depth]').forEach((layer) => {
      const depth = Number(layer.dataset.depth ?? 0);
      layer.style.transform = `translate3d(${-dx * depth * 40}px, ${-dy * depth * 40}px, 0)`;
    });
  };
  const reset = () => {
    ref.current?.querySelectorAll<HTMLElement>('[data-depth]').forEach((l) => {
      l.style.transform = 'translate3d(0,0,0)';
    });
  };

  return (
    <div ref={ref} onMouseMove={onMove} onMouseLeave={reset} className={className}>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Export it + verify web build**

Ensure `index.ts` exports `ParallaxHero` (see Task 6 Step 4). Run from `apps/web`:
```bash
npx vite build
```
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/depth/
git commit -m "TDA-017: ParallaxHero layered pointer-parallax"
```

## Task 8: Extract shared ConnectAngelOne (Agent B)

**Files:**
- Create: `apps/web/src/components/broker/ConnectAngelOne.tsx`, `apps/web/src/components/broker/index.ts`
- Modify: `apps/web/src/pages/settings/SettingsPage.tsx`

**Interfaces:**
- Produces: `<ConnectAngelOne />` — the broker connect/disconnect card (moved verbatim from `SettingsPage`), consuming `GET/POST /broker`, `DELETE /broker`.

- [ ] **Step 1: Move the component into its own file**

Cut the `ConnectAngelOne` function (and its private helpers `BrokerStatusResponse`, `relativeTime`, `EMPTY_BROKER_FORM`) from `SettingsPage.tsx` into a new `apps/web/src/components/broker/ConnectAngelOne.tsx`. Add the imports it needs at the top of the new file:
```tsx
import { useState, useEffect, useCallback } from 'react';
import { CheckCircle, Eye, EyeOff, Plug } from 'lucide-react';
import { LoadingSkeleton } from '@/components/common';
import api from '@/services/api';
import toast from 'react-hot-toast';
```
Export it: `export function ConnectAngelOne() { … }`. Create `apps/web/src/components/broker/index.ts`:
```ts
export { ConnectAngelOne } from './ConnectAngelOne';
```

- [ ] **Step 2: Import it back into SettingsPage**

In `SettingsPage.tsx`, remove the now-moved code and add:
```ts
import { ConnectAngelOne } from '@/components/broker';
```
Remove the `Eye`, `EyeOff`, `Plug` (and any now-unused) icon imports that were only used by the moved component. The `<ConnectAngelOne />` usage in `UserAccountHub` stays as-is.

- [ ] **Step 3: Verify typecheck + build**

Run from `apps/web`:
```bash
npx tsc --noEmit -p tsconfig.json && npx vite build
```
Expected: no type errors from the move; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/broker/ apps/web/src/pages/settings/SettingsPage.tsx
git commit -m "TDA-017: extract shared ConnectAngelOne component"
```

## Task 9: SignalCard + SignalSummaryStrip (Agent B)

**Files:**
- Create: `apps/web/src/components/signals/signal-card.ts`, `SignalCard.tsx`, `SignalSummaryStrip.tsx`, `index.ts`
- Test: `apps/web/src/components/signals/signal-card.spec.ts`

**Interfaces:**
- Consumes: `AnandEntry`, `PnlSummary` from `@/services/anand`.
- Produces:
  - `signalPnl(entry: AnandEntry, notional: number): { pnlRs: number | null; pnlPct: number | null; priceShown: number; stale: boolean }` (pure).
  - `<SignalCard entry: AnandEntry, isAdmin: boolean, notional: number>` — one interactive card; ADMIN-only expandable detail renders scanner/score/trailing; the USER path renders none of those.
  - `<SignalSummaryStrip pnl?: PnlSummary, openCount, invested, currentValue, unrealizedRs>` — the restyled period P&L + capital strip.

- [ ] **Step 1: Write the failing test for `signalPnl`**

Create `apps/web/src/components/signals/signal-card.spec.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { signalPnl } from './signal-card';
import type { AnandEntry } from '@/services/anand';

const base = (over: Partial<AnandEntry>): AnandEntry =>
  ({ id: '1', symbol: 'X', token: '1', entryPrice: 100, targetPct: 5, status: 'TRADED', enteredAt: new Date().toISOString(), ...over } as AnandEntry);

describe('signalPnl', () => {
  it('computes rupee P&L from pnlPct against notional', () => {
    const r = signalPnl(base({ pnlPct: 5, currentPrice: 105, exitPrice: null }), 200_000);
    expect(r.pnlPct).toBe(5);
    expect(r.pnlRs).toBe(10_000);
    expect(r.priceShown).toBe(105);
    expect(r.stale).toBe(false);
  });
  it('returns null P&L and stale when an open row has no live price', () => {
    const r = signalPnl(base({ pnlPct: null, currentPrice: null, exitPrice: null, priceStale: true }), 200_000);
    expect(r.pnlRs).toBeNull();
    expect(r.stale).toBe(true);
  });
  it('uses exitPrice for a closed row', () => {
    const r = signalPnl(base({ pnlPct: -5, exitPrice: 95 }), 200_000);
    expect(r.priceShown).toBe(95);
    expect(r.pnlRs).toBe(-10_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `apps/web`: `npx vitest run src/components/signals/signal-card.spec.ts`
Expected: FAIL — cannot resolve `./signal-card`.

- [ ] **Step 3: Implement `signal-card.ts`**

```ts
import type { AnandEntry } from '@/services/anand';

/** Pure P&L derivation for a signal card, mirroring the legacy IntradayPage
 *  row math (NOTIONAL-based rupee P&L; stale when an open row has no price). */
export function signalPnl(
  entry: AnandEntry,
  notional: number,
): { pnlRs: number | null; pnlPct: number | null; priceShown: number; stale: boolean } {
  const isActive = entry.exitPrice == null;
  const stale = entry.priceStale === true;
  const pnlPct = entry.pnlPct ?? null;
  const pnlRs = pnlPct == null ? null : (pnlPct / 100) * notional;
  const priceShown = isActive ? entry.currentPrice ?? 0 : entry.exitPrice ?? 0;
  return { pnlRs, pnlPct, priceShown, stale };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/signals/signal-card.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Implement `SignalCard.tsx`**

```tsx
import { useState } from 'react';
import clsx from 'clsx';
import { SymbolChartLink } from '@/components/common';
import ChartinkScoreTable from '@/components/chartink/ChartinkScoreTable';
import { TiltCard } from '@/components/depth';
import type { AnandEntry } from '@/services/anand';
import { signalPnl } from './signal-card';

const inrFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const fmtSignedRs = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}₹${inrFmt.format(Math.abs(Math.round(n)))}`;
const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const moneyColor = (n: number | null) =>
  n == null ? 'text-[var(--color-text-muted)]' : n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-[var(--color-text-muted)]';

const STATUS_TONE: Record<string, string> = {
  TRADED: 'bg-blue-500/15 text-blue-300',
  TARGET_HIT: 'bg-emerald-500/15 text-emerald-300',
  STOPPED: 'bg-red-500/15 text-red-300',
  EXPIRED: 'bg-gray-500/15 text-gray-300',
};

/** One interactive signal as a depth card. USER path renders NO provenance;
 *  scanner/score/trailing/exitReason live only in the ADMIN-gated expander. */
export function SignalCard({ entry, isAdmin, notional }: { entry: AnandEntry; isAdmin: boolean; notional: number }) {
  const [open, setOpen] = useState(false);
  const { pnlRs, pnlPct, priceShown, stale } = signalPnl(entry, notional);
  const isActive = entry.exitPrice == null;

  return (
    <TiltCard maxTiltDeg={6}>
      <div className="depth-card depth-rise rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4">
        <div className="flex items-start justify-between">
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-base font-semibold text-[var(--color-text-primary)]">
              <SymbolChartLink symbol={entry.symbol} token={entry.token} />
            </span>
            <span className="text-xs text-[var(--color-text-muted)] tabular-nums">Entry ₹{entry.entryPrice.toFixed(2)} · Tgt {entry.targetPct}%</span>
          </div>
          <span className={clsx('rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider', STATUS_TONE[entry.status] ?? 'bg-gray-500/15 text-gray-300')}>
            {entry.status.replace('_', ' ')}
          </span>
        </div>

        <div className="mt-3 flex items-end justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">{isActive ? 'Live' : 'Exit'} Price</div>
            <div className="text-lg font-semibold tabular-nums text-[var(--color-text-primary)]">
              {stale ? <span className="text-[var(--color-text-muted)]">— stale</span> : `₹${priceShown.toFixed(2)}`}
            </div>
          </div>
          <div className="text-right">
            <div className={clsx('text-lg font-bold tabular-nums', moneyColor(pnlRs))}>{pnlRs == null ? '—' : fmtSignedRs(pnlRs)}</div>
            <div className={clsx('text-xs tabular-nums', moneyColor(pnlPct))}>{pnlPct == null ? '' : fmtPct(pnlPct)}</div>
          </div>
        </div>

        {isAdmin && (
          <div className="mt-3 border-t border-[var(--color-border-subtle)] pt-2">
            <button onClick={() => setOpen((v) => !v)} className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
              {open ? 'Hide' : 'Show'} internals {entry.scannerName ? `· ${entry.scannerName}` : ''}
            </button>
            {open && entry.scoreBreakdown && (
              <div className="mt-2">
                <ChartinkScoreTable
                  score={entry.scoreBreakdown.filter((c) => c.passed).reduce((s, c) => s + c.points, 0)}
                  lotCount={0}
                  checks={entry.scoreBreakdown}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </TiltCard>
  );
}
```

- [ ] **Step 6: Implement `SignalSummaryStrip.tsx`**

```tsx
import clsx from 'clsx';
import { TiltCard } from '@/components/depth';
import { CapitalStrip } from '@/components/anand/CapitalStrip';
import type { PnlSummary, PnlPeriod } from '@/services/anand';

const inrFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const fmtSignedRs = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}₹${inrFmt.format(Math.abs(Math.round(n)))}`;
const moneyColor = (n: number) => (n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-[var(--color-text-muted)]');

function PnlTile({ label, period }: { label: string; period: PnlPeriod }) {
  const has = period.count > 0;
  return (
    <TiltCard maxTiltDeg={5} className="flex-1 min-w-[150px]">
      <div className="glass-panel depth-card p-4">
        <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
        <div className={clsx('mt-1 text-xl font-bold tabular-nums', has ? moneyColor(period.totalPnlRs) : 'text-[var(--color-text-muted)]')}>
          {has ? fmtSignedRs(period.totalPnlRs) : '—'}
        </div>
        <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)] tabular-nums">{has ? `${period.count}t · ${period.winCount}W` : '— · —'}</div>
      </div>
    </TiltCard>
  );
}

export function SignalSummaryStrip({
  pnl, openCount, invested, currentValue, unrealizedRs,
}: { pnl?: PnlSummary; openCount: number; invested: number; currentValue: number; unrealizedRs: number }) {
  return (
    <div className="flex flex-col gap-3">
      {pnl && (
        <div className="flex flex-wrap gap-3">
          <PnlTile label="Daily" period={pnl.daily} />
          <PnlTile label="Weekly" period={pnl.weekly} />
          <PnlTile label="Monthly" period={pnl.monthly} />
          <PnlTile label="Yearly" period={pnl.yearly} />
        </div>
      )}
      {openCount > 0 && <CapitalStrip openCount={openCount} invested={invested} currentValue={currentValue} unrealizedRs={unrealizedRs} />}
    </div>
  );
}
```

Create `apps/web/src/components/signals/index.ts`:
```ts
export { SignalCard } from './SignalCard';
export { SignalSummaryStrip } from './SignalSummaryStrip';
export { signalPnl } from './signal-card';
```

- [ ] **Step 7: Verify build + commit**

Run from `apps/web`: `npx vitest run src/components/signals/signal-card.spec.ts && npx vite build`
Expected: tests PASS; build succeeds.
```bash
git add apps/web/src/components/signals/
git commit -m "TDA-017: SignalCard + SignalSummaryStrip + pure signalPnl"
```

---

# WAVE 2 — Pages (Agents C–F, parallel; depend on Wave 1)

## Task 10: Payments page (Agent C) — depends on Task 4

**Files:**
- Create: `apps/web/src/hooks/usePayments.ts`, `apps/web/src/hooks/usePayments.spec.ts`, `apps/web/src/pages/payments/PaymentsPage.tsx`

**Interfaces:**
- Consumes: `GET /api/me/billing/payments` → `PaymentView[]`; `TiltCard` from `@/components/depth`.
- Produces: `usePayments(): { payments: PaymentRow[]; loading: boolean; error: string | null }`; `groupByMonth(rows: PaymentRow[]): { month: string; rows: PaymentRow[] }[]` (pure); `<PaymentsPage />`.

- [ ] **Step 1: Write the failing test for `groupByMonth`**

Create `apps/web/src/hooks/usePayments.spec.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { groupByMonth, type PaymentRow } from './usePayments';

const row = (over: Partial<PaymentRow>): PaymentRow =>
  ({ id: '1', segment: 'INTRADAY', amount: 49900, currency: 'INR', status: 'CAPTURED', providerPaymentId: 'p', invoiceUrl: null, description: null, createdAt: '2026-06-15T10:00:00.000Z', ...over });

describe('groupByMonth', () => {
  it('groups rows by calendar month, newest month first', () => {
    const groups = groupByMonth([
      row({ id: 'a', createdAt: '2026-06-15T10:00:00.000Z' }),
      row({ id: 'b', createdAt: '2026-07-01T10:00:00.000Z' }),
      row({ id: 'c', createdAt: '2026-06-02T10:00:00.000Z' }),
    ]);
    expect(groups[0].rows.map((r) => r.id)).toEqual(['b']);
    expect(groups[1].rows.map((r) => r.id).sort()).toEqual(['a', 'c']);
  });
  it('returns [] for no rows', () => {
    expect(groupByMonth([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `apps/web`: `npx vitest run src/hooks/usePayments.spec.ts`
Expected: FAIL — cannot resolve `./usePayments`.

- [ ] **Step 3: Implement `usePayments.ts`**

```ts
import { useEffect, useState } from 'react';
import api from '@/services/api';

export interface PaymentRow {
  id: string;
  segment: string | null;
  amount: number;       // paise
  currency: string;
  status: 'CAPTURED' | 'FAILED' | 'REFUNDED' | string;
  providerPaymentId: string;
  invoiceUrl: string | null;
  description: string | null;
  createdAt: string;
}

/** Group payments by "YYYY-MM", newest month first (rows within a month keep
 *  server order — already newest-first from the endpoint). */
export function groupByMonth(rows: PaymentRow[]): { month: string; rows: PaymentRow[] }[] {
  const map = new Map<string, PaymentRow[]>();
  for (const r of rows) {
    const d = new Date(r.createdAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    (map.get(key) ?? map.set(key, []).get(key)!).push(r);
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([month, rs]) => ({ month, rows: rs }));
}

export function usePayments(): { payments: PaymentRow[]; loading: boolean; error: string | null } {
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { data } = await api.get<PaymentRow[]>('/me/billing/payments');
        if (active) setPayments(data);
      } catch {
        if (active) setError('Could not load payments');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  return { payments, loading, error };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hooks/usePayments.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Implement `PaymentsPage.tsx`**

```tsx
import { CreditCard, ExternalLink } from 'lucide-react';
import clsx from 'clsx';
import { TiltCard } from '@/components/depth';
import { usePayments, groupByMonth, type PaymentRow } from '@/hooks/usePayments';

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const fmtAmount = (paise: number) => inr.format(paise / 100);
const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
};
const STATUS_TONE: Record<string, string> = {
  CAPTURED: 'bg-emerald-500/15 text-emerald-300',
  FAILED: 'bg-red-500/15 text-red-300',
  REFUNDED: 'bg-amber-500/15 text-amber-300',
};

function Row({ p }: { p: PaymentRow }) {
  return (
    <TiltCard maxTiltDeg={4}>
      <div className="depth-card depth-rise flex items-center justify-between rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] px-4 py-3">
        <div className="flex flex-col">
          <span className="text-sm font-medium text-[var(--color-text-primary)]">{p.description ?? p.segment ?? 'Payment'}</span>
          <span className="text-[11px] text-[var(--color-text-muted)] tabular-nums">
            {new Date(p.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className={clsx('rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase', STATUS_TONE[p.status] ?? 'bg-gray-500/15 text-gray-300')}>{p.status}</span>
          <span className="text-sm font-semibold tabular-nums text-[var(--color-text-primary)]">{fmtAmount(p.amount)}</span>
          {p.invoiceUrl && (
            <a href={p.invoiceUrl} target="_blank" rel="noreferrer" className="text-[var(--color-accent-blue)] hover:opacity-80"><ExternalLink size={15} /></a>
          )}
        </div>
      </div>
    </TiltCard>
  );
}

export default function PaymentsPage() {
  const { payments, loading, error } = usePayments();
  const groups = groupByMonth(payments);

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex items-center gap-3">
        <CreditCard size={24} className="text-[var(--color-text-secondary)]" />
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Payments</h1>
      </div>

      {loading && <div className="text-[var(--color-text-muted)]">Loading…</div>}
      {error && <div className="text-red-400">{error}</div>}
      {!loading && !error && payments.length === 0 && (
        <div className="glass-panel p-8 text-center text-[var(--color-text-muted)]">
          No payments yet. Your subscription charges will appear here.
        </div>
      )}

      {groups.map((g) => (
        <div key={g.month} className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{monthLabel(g.month)}</h2>
          {g.rows.map((p) => <Row key={p.id} p={p} />)}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Verify build + commit**

Run from `apps/web`: `npx vitest run src/hooks/usePayments.spec.ts && npx vite build`
```bash
git add apps/web/src/hooks/usePayments.ts apps/web/src/hooks/usePayments.spec.ts apps/web/src/pages/payments/
git commit -m "TDA-017: Payments page + usePayments hook"
```

## Task 11: User Dashboard page (Agent D) — depends on Tasks 6, 8

**Files:**
- Create: `apps/web/src/hooks/useDashboard.ts`, `apps/web/src/hooks/useDashboard.spec.ts`, `apps/web/src/pages/dashboard/UserDashboardPage.tsx`

**Interfaces:**
- Consumes: `GET /api/portfolio/summary`, `/api/portfolio/segments` (tenant-scoped → caller's data); `GET /broker/status`; `TiltCard`, `SignalSummaryStrip` not needed here; shared `ConnectAngelOne` from `@/components/broker`.
- Produces: `useDashboard(): { summary: DashboardSummary | null; segments: SegmentPnl[]; broker: BrokerStatus | null; loading: boolean }`; `pickHeroStats(summary): { totalPnl: number; winRate: number; trades: number }` (pure, null-safe).

- [ ] **Step 1: Write the failing test for `pickHeroStats`**

Create `apps/web/src/hooks/useDashboard.spec.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { pickHeroStats } from './useDashboard';

describe('pickHeroStats', () => {
  it('reads totals from a populated summary', () => {
    expect(pickHeroStats({ totalPnl: 12345, winRate: 0.6, totalTrades: 20 } as never)).toEqual({ totalPnl: 12345, winRate: 0.6, trades: 20 });
  });
  it('is null-safe for an empty/paper account', () => {
    expect(pickHeroStats(null)).toEqual({ totalPnl: 0, winRate: 0, trades: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `apps/web`: `npx vitest run src/hooks/useDashboard.spec.ts`
Expected: FAIL — cannot resolve `./useDashboard`.

- [ ] **Step 3: Implement `useDashboard.ts`**

```ts
import { useEffect, useState } from 'react';
import api from '@/services/api';

export interface DashboardSummary { totalPnl: number; winRate: number; totalTrades: number }
export interface SegmentPnl { segment: string; pnl: number; trades: number }
export interface BrokerStatus { connected: boolean; clientIdMasked?: string | null; lastValidated?: string | null }

/** Null-safe hero stats — a paper/empty account has no summary yet. */
export function pickHeroStats(summary: DashboardSummary | null): { totalPnl: number; winRate: number; trades: number } {
  return { totalPnl: summary?.totalPnl ?? 0, winRate: summary?.winRate ?? 0, trades: summary?.totalTrades ?? 0 };
}

export function useDashboard() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [segments, setSegments] = useState<SegmentPnl[]>([]);
  const [broker, setBroker] = useState<BrokerStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      const [s, seg, b] = await Promise.allSettled([
        api.get<DashboardSummary>('/portfolio/summary'),
        api.get<SegmentPnl[]>('/portfolio/segments'),
        api.get<BrokerStatus>('/broker/status'),
      ]);
      if (!active) return;
      if (s.status === 'fulfilled') setSummary(s.value.data);
      if (seg.status === 'fulfilled') setSegments(Array.isArray(seg.value.data) ? seg.value.data : []);
      setBroker(b.status === 'fulfilled' ? b.value.data : { connected: false });
      setLoading(false);
    })();
    return () => { active = false; };
  }, []);

  return { summary, segments, broker, loading };
}
```
> Note: if `/portfolio/summary`/`/segments` return a different shape at runtime, adapt the field reads here at the fetch site (keep `pickHeroStats` pure). Default plan assumes `{ totalPnl, winRate, totalTrades }` / `[{ segment, pnl, trades }]`; verify against `portfolio.service.ts` during implementation and map if needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hooks/useDashboard.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Implement `UserDashboardPage.tsx`**

```tsx
import { LayoutDashboard, Plug } from 'lucide-react';
import clsx from 'clsx';
import { TiltCard } from '@/components/depth';
import { ConnectAngelOne } from '@/components/broker';
import { useDashboard, pickHeroStats } from '@/hooks/useDashboard';
import { useAuthStore } from '@/stores/auth-store';

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const fmtRs = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}₹${inr.format(Math.abs(Math.round(n)))}`;
const moneyColor = (n: number) => (n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-[var(--color-text-muted)]');

export default function UserDashboardPage() {
  const { summary, segments, broker, loading } = useDashboard();
  const hero = pickHeroStats(summary);
  const email = useAuthStore((s) => s.user?.email);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center gap-3">
        <LayoutDashboard size={24} className="text-[var(--color-text-secondary)]" />
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Dashboard</h1>
          <p className="text-xs text-[var(--color-text-muted)]">{email}</p>
        </div>
      </div>

      {/* Hero */}
      <TiltCard maxTiltDeg={5}>
        <div className="glass-panel depth-card p-6">
          <div className="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">Total P&L</div>
          <div className={clsx('mt-1 text-4xl font-bold tabular-nums', moneyColor(hero.totalPnl))}>
            {loading ? '—' : fmtRs(hero.totalPnl)}
          </div>
          <div className="mt-2 flex gap-6 text-xs text-[var(--color-text-muted)]">
            <span>{(hero.winRate * 100).toFixed(0)}% win rate</span>
            <span>{hero.trades} trades</span>
          </div>
          {!loading && hero.trades === 0 && (
            <p className="mt-3 text-xs text-[var(--color-text-muted)]">No executed trades yet — connect your broker and subscribe to a segment to begin.</p>
          )}
        </div>
      </TiltCard>

      {/* Segment breakdown */}
      {segments.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {segments.map((s) => (
            <TiltCard key={s.segment} maxTiltDeg={5}>
              <div className="depth-card depth-rise rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4">
                <div className="text-xs uppercase tracking-wider text-[var(--color-text-muted)]">{s.segment}</div>
                <div className={clsx('mt-1 text-xl font-bold tabular-nums', moneyColor(s.pnl))}>{fmtRs(s.pnl)}</div>
                <div className="text-[11px] text-[var(--color-text-muted)]">{s.trades} trades</div>
              </div>
            </TiltCard>
          ))}
        </div>
      )}

      {/* Angel One management */}
      <div className="rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-5">
        <div className="mb-3 flex items-center gap-2">
          <Plug size={18} className="text-[var(--color-text-secondary)]" />
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Angel One Account</h2>
          {broker?.connected && <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">Connected</span>}
        </div>
        <ConnectAngelOne />
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Verify build + commit**

Run from `apps/web`: `npx vitest run src/hooks/useDashboard.spec.ts && npx vite build`
```bash
git add apps/web/src/hooks/useDashboard.ts apps/web/src/hooks/useDashboard.spec.ts apps/web/src/pages/dashboard/UserDashboardPage.tsx
git commit -m "TDA-017: user Dashboard page + useDashboard hook"
```

## Task 12: Redesign Intraday + Swing (Agent E) — depends on Task 9

**Files:**
- Modify: `apps/web/src/pages/intraday/IntradayPage.tsx`, `apps/web/src/pages/swing/SwingPage.tsx`

**Interfaces:**
- Consumes: `SignalCard`, `SignalSummaryStrip` from `@/components/signals`; existing `useIntradayEntries`/`useSwingEntries`, `useSubscriptions`, `shouldShowSubscribeCard`, `summarizeOpenBook`.
- Produces: card/feed layouts replacing the tables; subscribe-gate + no-403 behavior unchanged; USER never sees provenance.

- [ ] **Step 1: Replace the Intraday table with the card feed**

In `IntradayPage.tsx`: keep all hooks and the two early returns (loading, subscribe-gate) exactly as-is. Replace the local `PnlCard`/`PnlBar`/`EntryRow` components and the final `<table>` block with the shared components. The return body becomes:
```tsx
  return (
    <div className="flex flex-col gap-5 p-6 text-[var(--color-text-primary)]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Intraday</h1>
          <p className="text-sm text-[var(--color-text-muted)]">5% → trailing (Supertrend 15m) · 5% stop · expires 15:15</p>
        </div>
        {openCount > 0 && (
          <span className={clsx('rounded-lg px-3 py-1.5 text-xs font-semibold tabular-nums glass-panel', unrealizedRs > 0 ? 'text-emerald-400' : unrealizedRs < 0 ? 'text-red-400' : 'text-[var(--color-text-muted)]')}>
            {unrealizedRs >= 0 ? '+' : '−'}₹{Math.abs(Math.round(unrealizedRs)).toLocaleString('en-IN')} unrealized
          </span>
        )}
      </div>

      <SignalSummaryStrip pnl={pnl ?? undefined} openCount={openCount} invested={invested} currentValue={currentValue} unrealizedRs={unrealizedRs} />

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button key={f.label} onClick={() => setFilter(f.value)}
            className={clsx('rounded-full px-3 py-1 text-sm transition-colors',
              filter === f.value ? 'bg-[var(--color-accent-blue)]/20 text-[var(--color-accent-blue)]' : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]')}>
            {f.label}
          </button>
        ))}
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          className="ml-auto rounded-lg bg-[var(--color-bg-tertiary)] px-2 py-1 text-sm text-[var(--color-text-secondary)]" />
      </div>

      {loading && <div className="text-[var(--color-text-muted)]">Loading…</div>}
      {error && <div className="text-red-400">Error: {error}</div>}
      {!loading && !error && (
        entries.length === 0 ? (
          <div className="glass-panel p-8 text-center text-[var(--color-text-muted)]">No entries for this day yet.</div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {entries.map((e) => <SignalCard key={e.id} entry={e} isAdmin={isAdmin} notional={NOTIONAL} />)}
          </div>
        )
      )}
    </div>
  );
```
Add imports at top: `import { SignalCard, SignalSummaryStrip } from '@/components/signals';` and remove the now-unused `ChartinkScoreTable`, `CapitalStrip`, `SymbolChartLink`, `React` fragment imports if nothing else uses them. Delete the `PnlCard`, `PnlBar`, `EntryRow` definitions.

- [ ] **Step 2: Apply the same redesign to Swing**

Open `SwingPage.tsx`. Mirror the Intraday changes: keep its hooks/gates, swap its table/rows for `SignalCard` in a responsive grid and `SignalSummaryStrip` for the P&L/capital header. Preserve any swing-specific copy (e.g. "10% target"). If `SwingPage` already shares helpers with Intraday, prefer the shared `@/components/signals` versions and delete the local duplicates.

- [ ] **Step 3: Provenance-boundary check (manual grep)**

Run from repo root:
```bash
grep -nE "scannerName|scoreBreakdown|trailing|exitReason" apps/web/src/pages/intraday/IntradayPage.tsx apps/web/src/pages/swing/SwingPage.tsx
```
Expected: **no matches** — all provenance now lives only inside `SignalCard`'s `isAdmin` branch. If any match remains in a page file, remove it.

- [ ] **Step 4: Verify build + commit**

Run from `apps/web`: `npx vite build`
Expected: build succeeds.
```bash
git add apps/web/src/pages/intraday/IntradayPage.tsx apps/web/src/pages/swing/SwingPage.tsx
git commit -m "TDA-017: card/feed redesign for Intraday + Swing"
```

## Task 13: Landing 3D pass (Agent F) — depends on Tasks 6, 7

**Files:**
- Modify: `apps/web/src/pages/landing/LandingPage.tsx`

**Interfaces:**
- Consumes: `ParallaxHero`, `TiltCard` from `@/components/depth`.

- [ ] **Step 1: Wrap the hero in ParallaxHero and feature cards in TiltCard**

In `LandingPage.tsx`, import `import { ParallaxHero, TiltCard } from '@/components/depth';`. Wrap the top hero section in `<ParallaxHero className="…">` and give its decorative/background layers `data-depth="0.3"` (background), `data-depth="0.15"` (mid), and leave the headline text without `data-depth` (foreground stays put). Wrap each feature/benefit card in `<TiltCard maxTiltDeg={6}>` and add `depth-card depth-rise` classes to the card surface. Do not change copy or routes.

- [ ] **Step 2: Verify build + reduced-motion sanity**

Run from `apps/web`: `npx vite build`
Expected: build succeeds. (Reduced-motion is handled globally by the Task 5 guard — no per-page work.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/landing/LandingPage.tsx
git commit -m "TDA-017: 3D parallax + tilt on landing page"
```

---

# INTEGRATION (serialized — single owner, after Wave 2)

## Task 14: Wire routes + nav

**Files:**
- Modify: `apps/web/src/App.tsx`, `apps/web/src/components/layout/navItems.ts`

**Interfaces:**
- Consumes: `PaymentsPage` (default export), `UserDashboardPage` (default export).

- [ ] **Step 1: Add imports + routes in `App.tsx`**

Add imports:
```ts
import PaymentsPage from '@/pages/payments/PaymentsPage';
import UserDashboardPage from '@/pages/dashboard/UserDashboardPage';
```
Change the USER index element from `<Navigate to="/intraday" replace />` to `<UserDashboardPage />`:
```tsx
        <Route index element={<RequireRoleSwitch admin={<DashboardPage />} user={<UserDashboardPage />} />} />
```
Add the payments route inside the authenticated `<Route element={<RequireAuth><AppLayout/></RequireAuth>}>` block (USER-reachable, no role gate):
```tsx
        <Route path="payments" element={<PaymentsPage />} />
```

- [ ] **Step 2: Add nav items in `navItems.ts`**

Add two entries to the `navItems` array — Dashboard already exists at `/`; add Payments. Import `CreditCard` from `lucide-react` and insert after the `/positions` item:
```ts
  { path: '/payments', label: 'Payments', icon: CreditCard },
```
Update the `USER_VISIBLE` set to include Dashboard + Payments (Market/Charts kept per decision):
```ts
const USER_VISIBLE = new Set(['/', '/intraday', '/swing', '/positions', '/payments', '/market', '/charts', '/settings']);
```
> Note: the `/` Dashboard item already exists in `navItems`; adding `'/'` to `USER_VISIBLE` surfaces it for USERs. Its `end` prop is already handled in `Sidebar` (`end={item.path === '/'}`).

- [ ] **Step 3: Verify build**

Run from `apps/web`: `npx vite build`
Expected: build succeeds; no missing-import errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/components/layout/navItems.ts
git commit -m "TDA-017: wire Dashboard index + Payments route + USER nav"
```

## Task 15: Whole-branch review, full verification, single push

- [ ] **Step 1: Run every new test suite**

Backend (from `apps/api`):
```bash
DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_tda017 npx jest --config test/tda017/jest.config.js --runInBand
```
Frontend (from `apps/web`):
```bash
npx vitest run src/components/depth src/components/signals src/hooks/usePayments.spec.ts src/hooks/useDashboard.spec.ts
```
Expected: all PASS.

- [ ] **Step 2: Full builds**

```bash
cd apps/api && npx nest build && cd ../web && npx vite build
```
Expected: both succeed.

- [ ] **Step 3: Provenance regression sweep**

Run from repo root:
```bash
grep -rnE "scannerName|scoreBreakdown|exitReason" apps/web/src/pages/intraday apps/web/src/pages/swing apps/web/src/pages/payments apps/web/src/pages/dashboard
```
Expected: no matches outside an `isAdmin`-gated context (there should be none in these page files).

- [ ] **Step 4: Whole-branch review**

Dispatch a code review over the full TDA-017 diff (all commits since branch point) on the **opus** model, focused on: provenance leaks in the USER render path, reduced-motion coverage, tenant-scoping of the payments endpoint, webhook idempotency, and shared-file merge correctness. Fix anything CONFIRMED before Step 5.

- [ ] **Step 5: User UI verification gate**

Pause and ask the user to verify the running UI (web 4100) — Dashboard, Payments, redesigned Intraday/Swing, and landing 3D. Do NOT push until they confirm.

- [ ] **Step 6: Single push**

After user confirmation:
```bash
git push -u origin HEAD
```
(If working directly on `main`, confirm branch strategy with the user first — the project convention is a feature branch merged to `main`.)

---

## Self-Review (completed by plan author)

- **Spec coverage:** Payments page + real ledger → Tasks 1–4, 10. Dashboard (performance + Angel One) → Tasks 8, 11. Intraday/Swing card redesign → Tasks 9, 12. 3D system incl. landing → Tasks 5–7, 13. Nav/routes → Task 14. Testing/verification/single-commit → Task 15. All spec §2–§7 items map to a task.
- **Placeholder scan:** No TBD/"handle appropriately"; every code step shows real code; every test step shows the assertion and the run command with expected output.
- **Type consistency:** `PaymentView` (backend) ↔ `PaymentRow` (frontend) share field names; `signalPnl`/`computeTilt`/`pickHeroStats`/`groupByMonth` signatures match between their defining task and their consumers; `PaymentService.record`/`listForUser` signatures match the webhook + controller call sites.
- **Known implementation-time verification:** Task 11 flags that `/portfolio/summary`/`/segments` runtime shapes must be confirmed against `portfolio.service.ts` and mapped at the fetch site if they differ — the pure `pickHeroStats` stays stable regardless.
