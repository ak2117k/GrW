import { NotFoundException } from '@nestjs/common';
import {
  BrokerOverviewService,
  sanitizeTrades,
} from '../../src/modules/credential-vault/services/broker-overview.service';
import { PerUserBrokerSessionFactory } from '../../src/modules/auto-execution/services/per-user-broker-session.factory';

/**
 * A fake SmartAPI client (no network) exercising the REAL per-user session read
 * path for the trade book: generateSession → getTradeBook → logout. Angel One
 * wraps the read in a `{ data: [...] }` envelope, mirrored here. `tradeBook`
 * lets a test swap in null / [] / rows.
 */
function fakeSmartApi(tradeBook: any = DEFAULT_TRADEBOOK) {
  return {
    generateSession: async () => ({ data: { jwtToken: 'jwt-xyz' } }),
    // Overview reads (unused here but keep the client shape complete).
    getRMS: async () => ({ data: {} }),
    getProfile: async () => ({ data: {} }),
    getPosition: async () => ({ data: [] }),
    getAllHolding: async () => ({ data: {} }),
    getTradeBook: async () => ({ data: tradeBook }),
    placeOrder: async () => ({ data: { orderid: 'x' } }),
    logout: async () => ({ status: true }),
  };
}

/** Two executed trades with sortable filltimes (out of order to prove sorting). */
const DEFAULT_TRADEBOOK = [
  {
    tradingsymbol: 'SBIN-EQ',
    exchange: 'NSE',
    transactiontype: 'BUY',
    fillsize: '10',
    fillprice: '550.25',
    filltime: '09:30:15',
    producttype: 'DELIVERY',
    orderid: 'ORD-1',
  },
  {
    tradingsymbol: 'INFY-EQ',
    exchange: 'NSE',
    transactiontype: 'SELL',
    fillsize: '5',
    fillprice: '1500.75',
    filltime: '13:45:02',
    producttype: 'INTRADAY',
    orderid: 'ORD-2',
  },
];

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

// Default: NOT the feed account (isFeedAccount:false) + no feed session, so
// getTrades takes the ephemeral path. A test can override either.
function serviceWith(
  prisma: any,
  authService: any = { isAuthenticated: () => false, getSmartApi: () => null },
  tradeBook: any = DEFAULT_TRADEBOOK,
) {
  const p = { user: { findUnique: async () => ({ isFeedAccount: false }) }, ...prisma };
  const factory = new PerUserBrokerSessionFactory(() => fakeSmartApi(tradeBook) as any);
  return new BrokerOverviewService(fakeDecryptor as any, factory, p as any, authService as any);
}

describe('BrokerOverviewService.getTrades — sanitized trade book (TDA-017)', () => {
  it('maps a real per-user session (ephemeral login) into sanitized trade DTOs, newest-first', async () => {
    const prisma = { brokerCredential: { findUnique: async () => ({ userId: 'u1' }) } };
    const out = await serviceWith(prisma).getTrades('u1');

    expect(out).toEqual([
      {
        symbol: 'INFY-EQ',
        exchange: 'NSE',
        side: 'SELL',
        qty: 5,
        price: 1500.75,
        time: '13:45:02',
        product: 'INTRADAY',
        orderId: 'ORD-2',
      },
      {
        symbol: 'SBIN-EQ',
        exchange: 'NSE',
        side: 'BUY',
        qty: 10,
        price: 550.25,
        time: '09:30:15',
        product: 'DELIVERY',
        orderId: 'ORD-1',
      },
    ]);
  });

  it('leaks NOTHING beyond the whitelisted trade fields (no tokens/creds/raw envelope)', async () => {
    const prisma = { brokerCredential: { findUnique: async () => ({ userId: 'u1' }) } };
    const out = await serviceWith(prisma).getTrades('u1');
    const blob = JSON.stringify(out);

    for (const row of out) {
      expect(Object.keys(row).sort()).toEqual([
        'exchange',
        'orderId',
        'price',
        'product',
        'qty',
        'side',
        'symbol',
        'time',
      ]);
    }
    for (const secret of ['jwt', 'jwtToken', 'JBSWY3DPEHPK3PXP', 'apiKey', 'password']) {
      expect(blob).not.toContain(secret);
    }
  });

  it('returns [] when the broker trade book is empty', async () => {
    const prisma = { brokerCredential: { findUnique: async () => ({ userId: 'u1' }) } };
    const out = await serviceWith(prisma, undefined, []).getTrades('u1');
    expect(out).toEqual([]);
  });

  it('returns [] when the broker trade book is null (no trades)', async () => {
    const prisma = { brokerCredential: { findUnique: async () => ({ userId: 'u1' }) } };
    const out = await serviceWith(prisma, undefined, null).getTrades('u1');
    expect(out).toEqual([]);
  });

  it('throws NotFoundException (→404) when the user has no stored creds', async () => {
    const prisma = { brokerCredential: { findUnique: async () => null } };
    await expect(serviceWith(prisma).getTrades('u1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reads via the feed session (NO ephemeral login) when the caller IS the feed account', async () => {
    const prisma = {
      brokerCredential: { findUnique: async () => ({ userId: 'u1' }) },
      user: { findUnique: async () => ({ isFeedAccount: true }) },
    };
    let ephemeralUsed = false;
    const decryptorSpy = {
      withDecryptedCredentials: async () => {
        ephemeralUsed = true;
        return null;
      },
    };
    const factory = new PerUserBrokerSessionFactory(() => fakeSmartApi() as any);
    const authService = { isAuthenticated: () => true, getSmartApi: () => fakeSmartApi() };
    const svc = new BrokerOverviewService(decryptorSpy as any, factory, prisma as any, authService as any);

    const out = await svc.getTrades('u1');

    expect(ephemeralUsed).toBe(false); // reused the live feed session — no second login
    expect(out.map((t) => t.orderId)).toEqual(['ORD-2', 'ORD-1']);
    expect(out[0].side).toBe('SELL');
  });
});

describe('sanitizeTrades — empties, coercion & ordering', () => {
  it('returns [] for null / non-array data', () => {
    expect(sanitizeTrades(null)).toEqual([]);
    expect(sanitizeTrades(undefined)).toEqual([]);
    expect(sanitizeTrades({})).toEqual([]);
  });

  it('coerces numeric strings, falls back fillsize→quantity, and tolerates absent fields', () => {
    const out = sanitizeTrades([
      { tradingsymbol: 'T', exchange: 'NSE', transactiontype: 'BUY', quantity: '3', fillprice: '', filltime: null },
    ]);
    expect(out).toEqual([
      { symbol: 'T', exchange: 'NSE', side: 'BUY', qty: 3, price: 0, time: '', product: '', orderId: '' },
    ]);
  });

  it('preserves broker order when any row lacks a sortable time', () => {
    const out = sanitizeTrades([
      { tradingsymbol: 'A', filltime: '10:00:00', orderid: '1' },
      { tradingsymbol: 'B', filltime: '', orderid: '2' },
    ]);
    expect(out.map((t) => t.orderId)).toEqual(['1', '2']);
  });
});
