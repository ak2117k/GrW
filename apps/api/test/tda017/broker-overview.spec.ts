import { NotFoundException } from '@nestjs/common';
import {
  BrokerOverviewService,
  sanitizeOverview,
} from '../../src/modules/credential-vault/services/broker-overview.service';
import { PerUserBrokerSessionFactory } from '../../src/modules/auto-execution/services/per-user-broker-session.factory';

/**
 * A fake SmartAPI client (no network) exercising the REAL per-user session read
 * path: generateSession → getRMS/getProfile/getPosition → logout. Angel One wraps
 * every read in a `{ data: ... }` envelope, mirrored here.
 */
function fakeSmartApi() {
  return {
    generateSession: async () => ({ data: { jwtToken: 'jwt-xyz' } }),
    getRMS: async () => ({
      data: { availablecash: '1000.50', net: '2500', utiliseddebits: '499.25' },
    }),
    getProfile: async () => ({
      data: { name: 'Trader One', broker: 'ANGELBROKING', exchanges: ['NSE', 'BSE'] },
    }),
    getPosition: async () => ({
      data: [
        { tradingsymbol: 'SBIN-EQ', exchange: 'NSE', netqty: '10', ltp: '550.25', pnl: '120.5' },
      ],
    }),
    placeOrder: async () => ({ data: { orderid: 'x' } }),
    logout: async () => ({ status: true }),
  };
}

/** Decryptor stand-in: runs the lease callback with dummy creds, no KMS/Prisma. */
const fakeDecryptor = {
  withDecryptedCredentials: (_userId: string, _ctx: unknown, use: (c: any) => Promise<any>) =>
    use({
      apiKey: 'k',
      apiSecret: 's',
      clientId: 'AB1234',
      password: '1234',
      totpSecret: 'JBSWY3DPEHPK3PXP',
    }),
};

function serviceWith(prisma: any) {
  const factory = new PerUserBrokerSessionFactory(() => fakeSmartApi() as any);
  return new BrokerOverviewService(fakeDecryptor as any, factory, prisma as any);
}

describe('BrokerOverviewService — sanitized overview (TDA-017)', () => {
  it('maps a real per-user session (one login) into the sanitized DTO', async () => {
    const prisma = { brokerCredential: { findUnique: async () => ({ userId: 'u1' }) } };
    const out = await serviceWith(prisma).getOverview('u1');

    expect(out).toEqual({
      funds: { availableCash: 1000.5, net: 2500, utilisedMargin: 499.25 },
      profile: { name: 'Trader One', broker: 'ANGELBROKING', exchanges: ['NSE', 'BSE'] },
      positions: [
        { symbol: 'SBIN-EQ', exchange: 'NSE', netQty: 10, ltp: 550.25, pnl: 120.5 },
      ],
    });
  });

  it('leaks NOTHING beyond the whitelisted fields (no tokens/creds/raw envelope)', async () => {
    const prisma = { brokerCredential: { findUnique: async () => ({ userId: 'u1' }) } };
    const out = await serviceWith(prisma).getOverview('u1');
    const blob = JSON.stringify(out);

    expect(Object.keys(out).sort()).toEqual(['funds', 'positions', 'profile']);
    for (const secret of ['jwt', 'jwtToken', 'JBSWY3DPEHPK3PXP', 'apiKey', 'password', 'availablecash']) {
      expect(blob).not.toContain(secret);
    }
  });

  it('throws NotFoundException (→404) when the user has no stored creds', async () => {
    const prisma = { brokerCredential: { findUnique: async () => null } };
    await expect(serviceWith(prisma).getOverview('u1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('sanitizeOverview — empties & numeric coercion', () => {
  it('returns sensible empties when sections are null', () => {
    expect(sanitizeOverview({ funds: null, profile: null, positions: null })).toEqual({
      funds: { availableCash: 0, net: 0, utilisedMargin: 0 },
      profile: { name: '', broker: 'angel_one', exchanges: [] },
      positions: [],
    });
  });

  it('coerces numeric strings and non-finite values to numbers', () => {
    const out = sanitizeOverview({
      funds: { availablecash: '12.5', net: 'not-a-number', utiliseddebits: 7 },
      profile: { name: 'X', exchanges: ['NSE'] },
      positions: [{ tradingsymbol: 'T', exchange: 'NSE', netqty: '-3', ltp: '', pnl: '9.9' }],
    });
    expect(out.funds).toEqual({ availableCash: 12.5, net: 0, utilisedMargin: 7 });
    expect(out.profile.broker).toBe('angel_one');
    expect(out.positions[0]).toEqual({ symbol: 'T', exchange: 'NSE', netQty: -3, ltp: 0, pnl: 9.9 });
  });
});
