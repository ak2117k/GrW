/**
 * TDA-005 Task 5 — CredentialVaultService write side (DB-backed).
 *
 * Mirrors the tda003 isolation.spec harness: services are wired by hand against
 * the scratch test DB (DATABASE_URL_TEST). A real LocalKmsProvider + real
 * AuditService + a MOCKED AngelOneValidator drive the vault.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_tda005 \
 *     npx jest --config test/tda005/jest.config.js credential-vault --verbose
 */
import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { AuditService } from '../../src/common/audit/audit.service';
import { LocalKmsProvider } from '../../src/common/crypto/kms/local-kms.provider';
import { CredentialVaultService } from '../../src/modules/credential-vault/services/credential-vault.service';

const testUrl = process.env.DATABASE_URL_TEST;
if (!testUrl) {
  throw new Error('DATABASE_URL_TEST must point at the scratch td_saas_tda005 DB');
}
process.env.DATABASE_URL = testUrl;
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'master-key-passphrase-tda005-xxxxxxxx';

const raw = new PrismaClient({ datasources: { db: { url: testUrl } } });
const als = new AsyncLocalStorage<Record<string, unknown>>();
const cls = new ClsService(als);
const tenant = new TenantContextService(cls);
const prisma = new PrismaService(tenant);
const kms = new LocalKmsProvider();
const audit = new AuditService(prisma);
const validator = { validateLogin: jest.fn() } as any;
const svc = new CredentialVaultService(prisma, kms, audit, validator);

const dto = {
  apiKey: 'API_KEY_1',
  apiSecret: 'API_SECRET_1',
  clientId: 'AB1234',
  password: 'PIN9999',
  totpSecret: 'JBSWY3DPEHPK3PXP',
};

const EMAIL_1 = 'tda005-vault-1@test.local';
const EMAIL_2 = 'tda005-vault-2@test.local';
let userId: string;
let userId2: string;

async function cleanup(): Promise<void> {
  await raw.user.deleteMany({ where: { email: { in: [EMAIL_1, EMAIL_2] } } });
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await cleanup();
  const [u1, u2] = await Promise.all([
    raw.user.create({ data: { email: EMAIL_1, passwordHash: 'x', role: 'USER' } }),
    raw.user.create({ data: { email: EMAIL_2, passwordHash: 'x', role: 'USER' } }),
  ]);
  userId = u1.id;
  userId2 = u2.id;
});

afterAll(async () => {
  await cleanup();
  await raw.$disconnect();
  await prisma.$disconnect();
});

describe('CredentialVaultService.connect', () => {
  it('validates then persists ciphertext + CREDENTIAL_CONNECT', async () => {
    validator.validateLogin.mockResolvedValue({ success: true, clientName: 'Test' });
    const res = await svc.connect(userId, dto, { ip: '1.2.3.4' });
    expect(res.connected).toBe(true);
    expect(res.validatedAt).toBeInstanceOf(Date);

    const row = await raw.brokerCredential.findUnique({ where: { userId } });
    expect(row).not.toBeNull();
    expect(row!.encTotpSecret).not.toContain(dto.totpSecret); // stored encrypted
    expect(row!.encApiKey).not.toContain(dto.apiKey);
    expect(row!.encDataKey).toMatch(/^v1:/); // wrapped DEK
    expect(row!.keyVersion).toBe('local-v1');
    expect(row!.clientIdMasked).toBeTruthy();
    expect(row!.clientIdMasked).not.toBe(dto.clientId); // masked, not raw

    const audits = await raw.auditLog.findMany({ where: { userId, action: 'CREDENTIAL_CONNECT' } });
    expect(audits.length).toBe(1);
    const metaStr = JSON.stringify(audits[0].meta);
    expect(metaStr).not.toContain(dto.password);
    expect(metaStr).not.toContain(dto.totpSecret);
    expect(metaStr).not.toContain(dto.apiSecret);
  });

  it('persists NOTHING when the test login fails (422)', async () => {
    validator.validateLogin.mockResolvedValue({ success: false });
    await expect(svc.connect(userId2, dto, {})).rejects.toThrow();
    expect(await raw.brokerCredential.findUnique({ where: { userId: userId2 } })).toBeNull();
  });
});

describe('CredentialVaultService.getStatus / disconnect', () => {
  it('getStatus reflects the connected row with masked client-id (no secrets)', async () => {
    validator.validateLogin.mockResolvedValue({ success: true, clientName: 'Test' });
    await svc.connect(userId, dto, { ip: '1.2.3.4' });
    const status = await svc.getStatus(userId);
    expect(status.connected).toBe(true);
    expect(status.clientIdMasked).toBeTruthy();
    expect(JSON.stringify(status)).not.toContain(dto.apiKey);
    expect(JSON.stringify(status)).not.toContain(dto.totpSecret);
  });

  it('disconnect deletes the row and emits CREDENTIAL_DELETE', async () => {
    await svc.disconnect(userId, { ip: '1.2.3.4' });
    expect(await raw.brokerCredential.findUnique({ where: { userId } })).toBeNull();
    const status = await svc.getStatus(userId);
    expect(status.connected).toBe(false);
    const del = await raw.auditLog.findMany({ where: { userId, action: 'CREDENTIAL_DELETE' } });
    expect(del.length).toBeGreaterThanOrEqual(1);
  });
});
