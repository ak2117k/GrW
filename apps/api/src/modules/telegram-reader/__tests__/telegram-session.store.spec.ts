import { randomBytes } from 'crypto';
import { TelegramSessionStore, maskPhone } from '../services/telegram-session.store';
import { CredentialDecryptor } from '../../credential-vault/execution/credential-decryptor';

/** Reversible fake KMS: "wraps" a DEK as base64 (the real field cipher seals the fields). */
function fakeKms() {
  return {
    keyVersion: () => 'test-v1',
    generateDataKey: async () => {
      const plaintext = randomBytes(32);
      return { plaintext, wrapped: `w:${plaintext.toString('base64')}`, keyVersion: 'test-v1' };
    },
    unwrapKey: async (w: string) => Buffer.from(w.slice(2), 'base64'),
    wrapKey: async (p: Buffer) => ({ wrapped: `w:${p.toString('base64')}`, keyVersion: 'test-v1' }),
  };
}

function fakePrisma() {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    telegramSession: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const prev = rows.get(where.userId);
        rows.set(where.userId, prev ? { ...prev, ...update } : { ...create });
      }),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => {
        const r = rows.get(where.userId);
        if (!r) throw new Error('not found');
        return r;
      }),
      findUnique: jest.fn(async ({ where }: any) => rows.get(where.userId) ?? null),
      deleteMany: jest.fn(async ({ where }: any) => rows.delete(where.userId)),
    },
  };
}

describe('TelegramSessionStore', () => {
  const API_HASH = '0123456789abcdef0123456789abcdef';
  const SESSION = '1BVtsOK8Bu-fake-string-session-value==';
  const PHONE = '+919876543210';

  function build() {
    const prisma = fakePrisma();
    const kms = fakeKms();
    const audit = { append: jest.fn(async () => undefined) };
    const decryptor = new CredentialDecryptor(prisma as any, kms as any, audit as any);
    const store = new TelegramSessionStore(prisma as any, kms as any, decryptor, audit as any);
    return { prisma, audit, store };
  }

  it('persists no plaintext and round-trips through the decryptor', async () => {
    const { prisma, audit, store } = build();
    await store.save('u1', { apiId: 12345, apiHash: API_HASH, session: SESSION, phone: PHONE }, { ip: '1.2.3.4' });

    const row = prisma.rows.get('u1')!;
    const persisted = JSON.stringify(row);
    expect(persisted).not.toContain(API_HASH);
    expect(persisted).not.toContain(SESSION);
    expect(persisted).not.toContain('9876543210');
    expect(row.phoneMasked).toBe(maskPhone(PHONE));
    expect(String(row.encSession).split(':')).toHaveLength(3);

    const got = await store.withSecrets('u1', async (s) => ({ ...s }));
    expect(got).toEqual({ apiHash: API_HASH, session: SESSION });

    const auditDump = JSON.stringify(audit.append.mock.calls);
    expect(auditDump).not.toContain(API_HASH);
    expect(auditDump).not.toContain(SESSION);
    expect(auditDump).not.toContain('9876543210');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'CREDENTIAL_CONNECT', target: 'telegram' }));
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'CREDENTIAL_DECRYPT', target: 'telegram' }));
  });

  it('meta exposes only non-secret fields', async () => {
    const { store } = build();
    await store.save('u1', { apiId: 7, apiHash: API_HASH, session: SESSION, phone: PHONE });
    const meta = await store.meta('u1');
    expect(Object.keys(meta!).sort()).toEqual(['apiId', 'connectedAt', 'lastError', 'phoneMasked', 'status', 'userId']);
  });

  it('masks all but the last two digits', () => {
    expect(maskPhone('+91 98765 43210')).toMatch(/^•+10$/);
  });
});
