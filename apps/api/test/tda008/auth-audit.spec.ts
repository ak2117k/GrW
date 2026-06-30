/**
 * TDA-008 Task 5 — auth/mfa audit writers route through AuditService.append.
 *
 * Drives a REAL signup + email-verify + login through the AuthModule HTTP seam
 * (mirrors test/tda002/auth-core.spec.ts) and proves the resulting `audit_logs`
 * rows are HASH-CHAINED — non-empty `hash` AND `prevHash` — rather than the
 * pre-Task-5 empty-string placeholders, and that `verifyChain('global')` stays
 * ok after those appends.
 *
 * Setup mirrors test/tda008/audit-chain.spec.ts: DATABASE_URL is pointed at the
 * throw-away `td_saas_test` DB BEFORE PrismaService is constructed; a scoped
 * PrismaService (ClsService -> TenantContextService -> PrismaService) backs a
 * standalone AuditService used only to call verifyChain; a second raw
 * PrismaClient reads ground truth. The tda008 jest.config maps `otplib` to an
 * inert stub so AuthModule (-> MfaService -> otplib) loads.
 *
 * The global chain is APPEND-ONLY and self-consistent: this test must NOT delete
 * its `audit_logs` rows (a gap would break the chain) and must NOT delete the
 * seeded user (the FK SetNull would null a HASHED userId -> HASH_MISMATCH). Only
 * the non-hashed token rows are cleaned up.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_test \
 *     npx jest --config test/tda008/jest.config.js auth-audit --verbose
 */

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-tda008';
process.env.EMAIL_TRANSPORT = 'console';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';
import { ClsModule, ClsService } from 'nestjs-cls';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { TenantModule } from '../../src/common/tenant/tenant.module';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { AuditModule } from '../../src/common/audit/audit.module';
import { AuditService } from '../../src/common/audit/audit.service';

const testUrl = process.env.DATABASE_URL_TEST;
if (!testUrl) {
  throw new Error(
    'DATABASE_URL_TEST must be set to the td_saas_test connection string ' +
      '(e.g. postgresql://postgres:postgres@127.0.0.1:5432/td_saas_test)',
  );
}
process.env.DATABASE_URL = testUrl;

// Ground-truth client: bypasses the tenant extension and AuditService entirely.
const raw = new PrismaClient({ datasources: { db: { url: testUrl } } });

// Scoped PrismaService wired exactly as Nest would, backing a standalone
// AuditService used purely to call verifyChain('global').
const als = new AsyncLocalStorage<Record<string, unknown>>();
const cls = new ClsService(als);
const tenant = new TenantContextService(cls);
const prisma = new PrismaService(tenant);
const audits = new AuditService(prisma);

interface HttpResult {
  status: number;
  body: any;
}

describe('TDA-008 Task 5 — auth audit rows are hash-chained', () => {
  let app: INestApplication;
  let baseUrl: string;
  const email = `tda008-authaudit-${Date.now()}@example.com`;
  const password = 'Sup3r-Str0ng-Pass!';

  const call = async (
    method: string,
    path: string,
    opts: { body?: unknown; token?: string } = {},
  ): Promise<HttpResult> => {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: any = undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  };

  beforeAll(async () => {
    await prisma.onModuleInit();
    // AuthModule on its own no longer boots standalone: PrismaService (TDA-003)
    // injects TenantContextService, which needs the CLS store + TenantModule
    // that AppModule supplies globally. Re-create that infra here. AuditModule
    // (@Global) is imported so AuthService can inject AuditService after Task 5.
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        TenantModule,
        AuditModule,
        AuthModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    await app.listen(0);
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    // APPEND-ONLY: leave audit_logs rows and the user in place (see header).
    const user = await raw.user.findUnique({ where: { email } });
    if (user) {
      await raw.refreshToken.deleteMany({ where: { userId: user.id } });
      await raw.verificationToken.deleteMany({ where: { userId: user.id } });
    }
    if (app) await app.close();
    await raw.$disconnect();
    await prisma.$disconnect();
  });

  it('writes hash-chained AUTH_* rows through a real signup+login; verifyChain stays ok', async () => {
    const signup = await call('POST', '/auth/signup', { body: { email, password } });
    expect(signup.status).toBe(201);
    const verificationToken: string = signup.body.verificationToken;
    expect(typeof verificationToken).toBe('string');

    const verified = await call('POST', '/auth/verify-email', {
      body: { token: verificationToken },
    });
    expect(verified.status).toBe(200);

    const login = await call('POST', '/auth/login', { body: { email, password } });
    expect(login.status).toBe(200);
    expect(typeof login.body.accessToken).toBe('string');

    const user = await raw.user.findUnique({ where: { email } });
    expect(user).not.toBeNull();

    const rows = await raw.auditLog.findMany({
      where: { userId: user!.id },
      orderBy: { seq: 'asc' },
    });

    // The flow emits at least AUTH_SIGNUP + AUTH_LOGIN for this user. Before
    // Task 5 the old helper called auditLog.create without `seq` (now required)
    // inside a swallow, so NO rows were written — this length check fails RED.
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('AUTH_SIGNUP');
    expect(actions).toContain('AUTH_LOGIN');

    // The crux: every row is hash-chained — 64-hex `hash` AND `prevHash`, never
    // the pre-Task-5 empty-string placeholder.
    for (const r of rows) {
      expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.prevHash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.hash).not.toBe('');
      expect(r.prevHash).not.toBe('');
    }

    const v = await audits.verifyChain('global');
    expect(v.ok).toBe(true);
  });
});
