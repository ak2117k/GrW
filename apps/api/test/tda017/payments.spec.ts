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
  // record() uses runWithoutTenant, which mutates the CLS store and therefore
  // requires an active scope — the background/system scope production always
  // provides via ClsMiddleware (the webhook is handled inline in the HTTP
  // request). Wrap in run(), exactly as tda007 subscription.spec drives it.
  await run(() => payments.record({ userId: uId, segment: 'INTRADAY', amount: 49900, status: 'CAPTURED', providerPaymentId: 'pay_dup', description: 'Intraday' }));
  await run(() => payments.record({ userId: uId, segment: 'INTRADAY', amount: 49900, status: 'CAPTURED', providerPaymentId: 'pay_dup', description: 'Intraday' }));
  const rows = await raw.payment.findMany({ where: { userId: uId, providerPaymentId: 'pay_dup' } });
  expect(rows).toHaveLength(1);
  expect(rows[0].amount).toBe(49900);
  expect(rows[0].status).toBe('CAPTURED');
});

it('listForUser returns only the caller rows, newest first', async () => {
  await run(() => payments.record({ userId: uId, segment: 'SWING', amount: 99900, status: 'CAPTURED', providerPaymentId: 'pay_u2' }));
  await run(() => payments.record({ userId: otherId, segment: 'SWING', amount: 12300, status: 'CAPTURED', providerPaymentId: 'pay_other' }));
  const mine = await run(() => payments.listForUser(uId));
  expect(mine.every((p) => p.providerPaymentId !== 'pay_other')).toBe(true);
  expect(mine.length).toBeGreaterThanOrEqual(2);
  const times = mine.map((p) => new Date(p.createdAt).getTime());
  expect(times).toEqual([...times].sort((a, b) => b - a));
});
