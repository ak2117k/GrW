/**
 * TDA-005 Task 6 — CredentialDecryptor scoped-lease (DB-backed).
 *
 * Seeds a connected user via CredentialVaultService, then exercises the sole
 * decrypt-for-execution boundary. Same hand-wired harness as credential-vault.spec.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_tda005 \
 *     npx jest --config test/tda005/jest.config.js credential-decryptor --verbose
 */
import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { AuditService } from '../../src/common/audit/audit.service';
import { LocalKmsProvider } from '../../src/common/crypto/kms/local-kms.provider';
import { CredentialVaultService } from '../../src/modules/credential-vault/services/credential-vault.service';
import { CredentialDecryptor } from '../../src/modules/credential-vault/execution/credential-decryptor';

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
const validator = { validateLogin: jest.fn().mockResolvedValue({ success: true }) } as any;
const vault = new CredentialVaultService(prisma, kms, audit, validator);
const decryptor = new CredentialDecryptor(prisma, kms, audit);

const dto = {
  apiKey: 'API_KEY_D',
  apiSecret: 'API_SECRET_D',
  clientId: 'CD5678',
  password: 'PIN1234',
  totpSecret: 'JBSWY3DPEHPK3PXP',
};

const EMAIL = 'tda005-decrypt-1@test.local';
let userId: string;

async function cleanup(): Promise<void> {
  await raw.user.deleteMany({ where: { email: EMAIL } });
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await cleanup();
  const u = await raw.user.create({ data: { email: EMAIL, passwordHash: 'x', role: 'USER' } });
  userId = u.id;
  await vault.connect(userId, dto, { ip: '9.9.9.9' });
});

afterAll(async () => {
  await cleanup();
  await raw.$disconnect();
  await prisma.$disconnect();
});

describe('CredentialDecryptor.withDecryptedCredentials', () => {
  it('leases the five plaintext values back to the callback', async () => {
    const got = await decryptor.withDecryptedCredentials(
      userId,
      { reason: 'ORDER', signalId: 's1' },
      async (c) => ({ ...c }),
    );
    expect(got).toEqual({
      apiKey: dto.apiKey,
      apiSecret: dto.apiSecret,
      clientId: dto.clientId,
      password: dto.password,
      totpSecret: dto.totpSecret,
    });
  });

  it('emits exactly one CREDENTIAL_DECRYPT with no secret in meta', async () => {
    await decryptor.withDecryptedCredentials(userId, { reason: 'ORDER', signalId: 's2' }, async (c) => c.totpSecret);
    const rows = await raw.auditLog.findMany({ where: { userId, action: 'CREDENTIAL_DECRYPT' } });
    // beforeAll did not decrypt; the first `it` decrypted once (s1), this one (s2).
    expect(rows.length).toBe(2);
    const latest = rows.find((r) => JSON.stringify(r.meta).includes('s2'))!;
    const metaStr = JSON.stringify(latest.meta);
    expect(metaStr).not.toContain(dto.totpSecret);
    expect(metaStr).not.toContain(dto.password);
    expect(metaStr).toContain('local-v1'); // keyVersion recorded
  });

  it('propagates the callback result', async () => {
    const r = await decryptor.withDecryptedCredentials(userId, { reason: 'REVALIDATE' }, async () => 42);
    expect(r).toBe(42);
  });

  it('still emits the audit row and rejects when the callback throws (finally path)', async () => {
    const before = await raw.auditLog.count({ where: { userId, action: 'CREDENTIAL_DECRYPT' } });
    await expect(
      decryptor.withDecryptedCredentials(userId, { reason: 'ORDER', signalId: 'boom' }, async () => {
        throw new Error('use failed');
      }),
    ).rejects.toThrow('use failed');
    const after = await raw.auditLog.count({ where: { userId, action: 'CREDENTIAL_DECRYPT' } });
    expect(after).toBe(before + 1);
  });

  it('throws when the encDataKey is tampered (GCM auth-tag fail, no plaintext)', async () => {
    const row = await raw.brokerCredential.findUnique({ where: { userId } });
    const bad = row!.encDataKey.slice(0, -2) + (row!.encDataKey.endsWith('A') ? 'B' : 'A');
    await raw.brokerCredential.update({ where: { userId }, data: { encDataKey: bad } });
    await expect(
      decryptor.withDecryptedCredentials(userId, { reason: 'ORDER' }, async (c) => c.apiKey),
    ).rejects.toThrow();
    // restore for any later specs
    await raw.brokerCredential.update({ where: { userId }, data: { encDataKey: row!.encDataKey } });
  });
});
