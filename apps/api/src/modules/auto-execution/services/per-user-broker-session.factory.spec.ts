import { PerUserBrokerSessionFactory, type UserSmartApiLike } from './per-user-broker-session.factory';

function fakeClient(): jest.Mocked<UserSmartApiLike> {
  return {
    generateSession: jest.fn().mockResolvedValue({ data: { jwtToken: 'jwt' } }),
    placeOrder: jest.fn().mockResolvedValue({ status: true, message: 'SUCCESS', data: { orderid: 'O1' } }),
    logout: jest.fn().mockResolvedValue({}),
    getRMS: jest.fn(),
    getProfile: jest.fn(),
    getPosition: jest.fn().mockResolvedValue({ status: true, data: [] }),
    getAllHolding: jest.fn(),
    getTradeBook: jest.fn(),
    getOrderBook: jest.fn().mockResolvedValue({ status: true, data: [{ orderid: 'O1', status: 'open' }] }),
  };
}
const CREDS = { apiKey: 'k', apiSecret: 's', clientId: 'C1', password: 'p', totpSecret: 'JBSWY3DPEHPK3PXP' };

describe('PerUserBrokerSessionFactory.borrow', () => {
  it('uses the given client without logging in or out', async () => {
    const client = fakeClient();
    const f = new PerUserBrokerSessionFactory(() => {
      throw new Error('must not build a client');
    });
    const r = await f.borrow(client, 'C1', (s) =>
      s.placeOrder(
        { symbol: 'X', token: '1', exchange: 'NFO', side: 'SELL', orderType: 'MARKET', quantity: 75, positionType: 'CARRYFORWARD' },
        'axMabc',
      ),
    );
    expect(r).toEqual({ orderId: 'O1', status: 'PLACED', message: 'SUCCESS' });
    expect(client.generateSession).not.toHaveBeenCalled();
    expect(client.logout).not.toHaveBeenCalled();
    expect(client.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        variety: 'NORMAL',
        tradingsymbol: 'X',
        symboltoken: '1',
        transactiontype: 'SELL',
        exchange: 'NFO',
        ordertype: 'MARKET',
        producttype: 'CARRYFORWARD',
        duration: 'DAY',
        quantity: '75',
        price: '0',
        ordertag: 'axMabc',
      }),
    );
  });

  it('never logs out the lent client even when the callback throws', async () => {
    const client = fakeClient();
    const f = new PerUserBrokerSessionFactory();
    await expect(
      f.borrow(client, 'C1', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(client.logout).not.toHaveBeenCalled();
    expect(client.generateSession).not.toHaveBeenCalled();
  });

  it('the borrowed wrapper is unusable after the callback', async () => {
    const f = new PerUserBrokerSessionFactory();
    let leaked: any;
    await f.borrow(fakeClient(), 'C1', async (s) => {
      leaked = s;
    });
    await expect(leaked.getOrderBookEnvelope()).rejects.toThrow(/disposed/);
  });

  it('getOrderBookEnvelope returns the raw envelope', async () => {
    const f = new PerUserBrokerSessionFactory();
    const env = await f.borrow(fakeClient(), 'C1', (s) => s.getOrderBookEnvelope());
    expect(env).toEqual({ status: true, data: [{ orderid: 'O1', status: 'open' }] });
  });
});

describe('PerUserBrokerSessionFactory.withSession (unchanged contract)', () => {
  it('logs in, runs, logs out', async () => {
    const client = fakeClient();
    const f = new PerUserBrokerSessionFactory(() => client);
    await f.withSession(CREDS, (s) => s.getPositionsEnvelope());
    expect(client.generateSession).toHaveBeenCalledTimes(1);
    expect(client.logout).toHaveBeenCalledWith('C1');
  });
});
