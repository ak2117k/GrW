/**
 * Safety batch 2, item 3: GET /api/broker/overview and /trades read the
 * caller's account only through a session on THAT user's own Angel account.
 * The shared AngelOneAuthService feed session is env-first, so it may belong to
 * another client code even for the isFeedAccount user.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { BrokerOverviewService } from './broker-overview.service';
import { PerUserBrokerSessionFactory } from '../../auto-execution/services/per-user-broker-session.factory';

const USER_CREDS = { apiKey: 'UK', apiSecret: 'US', clientId: 'U123', password: 'PW', totpSecret: 'JBSWY3DPEHPK3PXP' };

function client(owner: string) {
  return {
    generateSession: jest.fn(async () => ({ data: { jwtToken: 'jwt' } })),
    logout: jest.fn(async () => ({})),
    placeOrder: jest.fn(),
    getOrderBook: jest.fn(),
    getRMS: jest.fn(async () => ({ status: true, data: { net: '1000', availablecash: '1000' } })),
    getProfile: jest.fn(async () => ({ status: true, data: { name: owner, clientcode: owner } })),
    getPosition: jest.fn(async () => ({ status: true, data: [] })),
    getAllHolding: jest.fn(async () => ({ status: true, data: { holdings: [] } })),
    getTradeBook: jest.fn(async () => ({ status: true, data: [] })),
  };
}

function build(opts: { sharedClientId: string; warm?: boolean; sharedAuthenticated?: boolean; between?: boolean }) {
  const ephemeral = client('EPHEMERAL');
  const shared = client('SHARED');
  const warm = client('WARM');
  const factory = new PerUserBrokerSessionFactory(() => ephemeral);
  const prisma = {
    brokerCredential: { findUnique: jest.fn().mockResolvedValue({ id: 'bc1' }) },
    user: { findUnique: jest.fn().mockResolvedValue({ isFeedAccount: true }) },
  };
  const decryptor = { withDecryptedCredentials: jest.fn(async (_u: string, _c: unknown, use: any) => use({ ...USER_CREDS })) };
  const authService = {
    isAuthenticated: () => opts.sharedAuthenticated ?? true,
    getSmartApi: jest.fn(() => shared),
    getClientId: () => opts.sharedClientId,
  };
  const userFeeds = {
    leaseRestClient: jest.fn(() => (opts.warm ? { client: warm, clientId: 'U123', release: jest.fn() } : null)),
    hasSession: jest.fn(() => !!opts.warm || !!opts.between),
  };
  const instruments = { getInstrumentBySymbol: jest.fn().mockResolvedValue(null) };
  const service = new BrokerOverviewService(
    decryptor as never, factory, prisma as never, authService as never, instruments as never, userFeeds as never,
  );
  return { service, ephemeral, shared, warm, decryptor };
}

describe('BrokerOverviewService — whose account is read', () => {
  it('overview: env-first feed account of another client code is NOT used for the isFeedAccount user', async () => {
    const h = build({ sharedClientId: 'ENV999' });
    await h.service.getOverview('user_1');
    expect(h.shared.getRMS).not.toHaveBeenCalled();
    expect(h.shared.getPosition).not.toHaveBeenCalled();
    expect(h.ephemeral.generateSession).toHaveBeenCalledWith('U123', 'PW', expect.any(String));
    expect(h.ephemeral.getPosition).toHaveBeenCalled();
  });

  it('trades: env-first feed account of another client code is NOT used', async () => {
    const h = build({ sharedClientId: 'ENV999' });
    await h.service.getTrades('user_1');
    expect(h.shared.getTradeBook).not.toHaveBeenCalled();
    expect(h.ephemeral.getTradeBook).toHaveBeenCalled();
  });

  it('overview + trades: the warm per-user feed session is used without any login', async () => {
    const h = build({ sharedClientId: 'ENV999', warm: true });
    await h.service.getOverview('user_1');
    await h.service.getTrades('user_1');
    expect(h.warm.getPosition).toHaveBeenCalled();
    expect(h.warm.getTradeBook).toHaveBeenCalled();
    expect(h.warm.generateSession).not.toHaveBeenCalled();
    expect(h.ephemeral.generateSession).not.toHaveBeenCalled();
    expect(h.decryptor.withDecryptedCredentials).not.toHaveBeenCalled();
  });

  it('the shared feed session is used (no second login) when its client code equals the user\'s', async () => {
    const h = build({ sharedClientId: 'U123' });
    await h.service.getOverview('user_1');
    expect(h.shared.getPosition).toHaveBeenCalled();
    expect(h.ephemeral.generateSession).not.toHaveBeenCalled();
  });

  it('a feed session of this account between logins ⇒ 503, never a login over it', async () => {
    const h = build({ sharedClientId: 'ENV999', between: true });
    await expect(h.service.getOverview('user_1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(h.service.getTrades('user_1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(h.ephemeral.generateSession).not.toHaveBeenCalled();
  });
});
