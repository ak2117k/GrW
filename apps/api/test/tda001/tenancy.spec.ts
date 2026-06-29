import { db } from './test-prisma';

/**
 * TDA-001 — multi-tenant foundation integration tests.
 *
 * Runs against the dedicated `td_saas_test` database (DATABASE_URL_TEST),
 * which is provisioned via `prisma migrate deploy` + the seed script.
 */
afterAll(async () => {
  await db.$disconnect();
});

describe('TDA-001 multi-tenant foundation', () => {
  it('seeds the ADMIN user usr_admin_seed_0001 (role ADMIN, status ACTIVE)', async () => {
    const admin = await db.user.findUnique({ where: { id: 'usr_admin_seed_0001' } });
    expect(admin).not.toBeNull();
    expect(admin!.role).toBe('ADMIN');
    expect(admin!.status).toBe('ACTIVE');
  });

  it('seeds the placeholder consent document cdoc_seed_0001', async () => {
    const doc = await db.consentDocument.findUnique({ where: { id: 'cdoc_seed_0001' } });
    expect(doc).not.toBeNull();
    expect(doc!.version).toBe('2026-06-27.0-placeholder');
  });

  it('creates a full subscriber graph and cascades on delete', async () => {
    const user = await db.user.create({
      data: {
        email: `subscriber+${Date.now()}@test.local`,
        passwordHash: 'test-hash',
        subscriptions: { create: { segment: 'SWING' } },
        autoTradeConsents: { create: { segment: 'SWING' } },
        brokerCredential: {
          create: {
            encApiKey: 'enc-api-key',
            encApiSecret: 'enc-api-secret',
            encClientId: 'enc-client-id',
            encPassword: 'enc-password',
            encTotpSecret: 'enc-totp-secret',
            encDataKey: 'wrapped',
          },
        },
        consentRecords: {
          create: {
            version: '2026-06-27.0-placeholder',
            document: { connect: { id: 'cdoc_seed_0001' } },
          },
        },
      },
      include: { brokerCredential: true },
    });

    expect(user.brokerCredential?.encDataKey).toBe('wrapped');

    await db.user.delete({ where: { id: user.id } });

    expect(await db.subscription.findFirst({ where: { userId: user.id } })).toBeNull();
    expect(await db.autoTradeConsent.findFirst({ where: { userId: user.id } })).toBeNull();
    expect(await db.brokerCredential.findFirst({ where: { userId: user.id } })).toBeNull();
    expect(await db.consentRecord.findFirst({ where: { userId: user.id } })).toBeNull();
  });

  it('broker_credentials has NO plaintext columns and HAS the enc* columns', async () => {
    const rows = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'broker_credentials'`;
    const cols = rows.map((r) => r.column_name);

    for (const absent of ['apiKey', 'password', 'clientId', 'totpSecret']) {
      expect(cols).not.toContain(absent);
    }
    for (const present of ['encApiKey', 'encDataKey', 'keyVersion']) {
      expect(cols).toContain(present);
    }
  });

  it('trades.userId is NOT NULL', async () => {
    const rows = await db.$queryRaw<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'trades' AND column_name = 'userId'`;
    expect(rows.length).toBe(1);
    expect(rows[0].is_nullable).toBe('NO');
  });
});
