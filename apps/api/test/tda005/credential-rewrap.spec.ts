/**
 * TDA-005 Task 7 — key-rotation re-wrap job (DB-backed).
 *
 * Connect a user, force a stale keyVersion, run the job: the DEK is re-wrapped
 * under the current KEK, field ciphertext is byte-unchanged, keyVersion/
 * lastRotatedAt advance, and CREDENTIAL_ROTATE is emitted once — idempotently.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_tda005 \
 *     npx jest --config test/tda005/jest.config.js credential-rewrap --verbose
 */
import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { AuditService } from '../../src/common/audit/audit.service';
import { LocalKmsProvider } from '../../src/common/crypto/kms/local-kms.provider';
import { CredentialVaultService } from '../../src/modules/credential-vault/services/credential-vault.service';
import { CredentialRewrapJob } from '../../src/modules/credential-vault/jobs/credential-rewrap.job';

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
const job = new CredentialRewrapJob(prisma, kms, audit);

const dto = {
  apiKey: 'API_KEY_R',
  apiSecret: 'API_SECRET_R',
  clientId: 'RW9012',
  password: 'PIN5555',
  totpSecret: 'JBSWY3DPEHPK3PXP',
};

const EMAIL = 'tda005-rewrap-1@test.local';
let userId: string;

async function cleanup(): Promise<void> {
  await raw.user.deleteMany({ where: { email: EMAIL } });
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await cleanup();
  const u = await raw.user.create({ data: { email: EMAIL, passwordHash: 'x', role: 'USER' } });
  userId = u.id;
  await vault.connect(userId, dto, { ip: '1.1.1.1' });
});

afterAll(async () => {
  await cleanup();
  await raw.$disconnect();
  await prisma.$disconnect();
});

describe('CredentialRewrapJob.rewrapAll', () => {
  it('re-wraps the DEK without touching field ciphertext, idempotently', async () => {
    await raw.brokerCredential.update({ where: { userId }, data: { keyVersion: 'stale-v0' } });
    const before = await raw.brokerCredential.findUnique({ where: { userId } });

    await job.rewrapAll();
    const after = await raw.brokerCredential.findUnique({ where: { userId } });

    expect(after!.encDataKey).not.toBe(before!.encDataKey); // DEK re-wrapped
    expect(after!.encApiKey).toBe(before!.encApiKey);        // fields untouched
    expect(after!.encTotpSecret).toBe(before!.encTotpSecret);
    expect(after!.keyVersion).toBe('local-v1');
    expect(after!.lastRotatedAt).not.toBeNull();

    const auditsBefore = await raw.auditLog.count({ where: { userId, action: 'CREDENTIAL_ROTATE' } });
    expect(auditsBefore).toBe(1);

    await job.rewrapAll(); // idempotent: row already current → no-op, no new audit row
    const auditsAfter = await raw.auditLog.count({ where: { userId, action: 'CREDENTIAL_ROTATE' } });
    expect(auditsAfter).toBe(auditsBefore);
  });

  it('the re-wrapped DEK still decrypts the untouched fields', async () => {
    // Sanity: the whole point is cheap rotation with no field re-encryption.
    const { CredentialDecryptor } = await import(
      '../../src/modules/credential-vault/execution/credential-decryptor'
    );
    const decryptor = new CredentialDecryptor(prisma, kms, audit);
    const got = await decryptor.withDecryptedCredentials(userId, { reason: 'REVALIDATE' }, async (c) => c.apiKey);
    expect(got).toBe(dto.apiKey);
  });
});
