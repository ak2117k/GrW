import { PerUserBrokerSessionFactory, classifyCancelResponse, type UserSmartApiLike } from './per-user-broker-session.factory';

function fakeClient(): jest.Mocked<Required<UserSmartApiLike>> {
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
    cancelOrder: jest.fn().mockResolvedValue({ status: true, message: 'SUCCESS', errorcode: '', data: { orderid: 'SL1' } }),
    convertPosition: jest.fn().mockResolvedValue({ status: true, message: 'SUCCESS', data: null }),
    modifyOrder: jest.fn().mockResolvedValue({ status: true, message: 'SUCCESS', errorcode: '', data: { orderid: 'SL1' } }),
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

/**
 * smartapi-javascript@1.0.27 installs an axios response-error interceptor that
 * RESOLVES instead of rejecting: a network error / its 7 s timeout → `{}`, an
 * HTTP error → `{ status: <http>, message: <statusText> }`, an interceptor fault
 * → `[]`. None of those is Angel saying "rejected": the order may exist.
 */
describe('placeOrderClassified — only Angel itself can say REJECTED (SDK interceptor never rejects)', () => {
  const ORDER = { symbol: 'X', token: '1', exchange: 'NFO', side: 'SELL', orderType: 'MARKET', quantity: 75, positionType: 'CARRYFORWARD' } as const;
  const run = async (answer: () => Promise<unknown>) => {
    const client = fakeClient();
    client.placeOrder.mockImplementation(answer as never);
    const f = new PerUserBrokerSessionFactory();
    const r = await f.borrow(client, 'C1', (s) => s.placeOrderClassified(ORDER as never, 'axMabc'));
    expect(client.placeOrder).toHaveBeenCalledTimes(1);
    expect(client.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ ordertag: 'axMabc', ordertype: 'MARKET' }));
    return r;
  };

  it.each([
    ['network error / SDK timeout → {}', {}],
    ['HTTP 504 → {status:504,message}', { status: 504, message: 'Gateway Time-out' }],
    ['HTTP 500 → {status:500}', { status: 500, message: 'Error' }],
    ['interceptor fault → []', []],
    ['undefined', undefined],
    ['null', null],
    ['a non-JSON body', '<html>bad gateway</html>'],
    ['status:false with no Angel message or code', { status: false }],
    ['status:true but no orderid', { status: true, message: 'SUCCESS', data: null }],
  ])('%s → UNCERTAIN', async (_n, answer) => {
    await expect(run(async () => answer)).resolves.toEqual(expect.objectContaining({ status: 'UNCERTAIN', orderId: '' }));
  });

  it('a thrown/timed-out call → UNCERTAIN', async () => {
    await expect(run(async () => { throw new Error('socket hang up'); })).resolves.toEqual({
      status: 'UNCERTAIN', orderId: '', message: 'socket hang up',
    });
  });

  it('Angel answered status:false with its errorcode/message → REJECTED (definitive)', async () => {
    await expect(run(async () => ({ status: false, message: 'Insufficient margin', errorcode: 'AB4036', data: null })))
      .resolves.toEqual({ status: 'REJECTED', orderId: '', message: 'Insufficient margin', errorcode: 'AB4036' });
    await expect(run(async () => ({ success: false, message: 'Invalid Token', errorCode: 'AG8001', data: null })))
      .resolves.toEqual({ status: 'REJECTED', orderId: '', message: 'Invalid Token', errorcode: 'AG8001' });
  });

  it('an orderid → PLACED', async () => {
    await expect(run(async () => ({ status: true, message: 'SUCCESS', data: { orderid: 'O1' } })))
      .resolves.toEqual({ status: 'PLACED', orderId: 'O1', message: 'SUCCESS' });
  });

  it('the legacy placeOrder contract is unchanged ({} is still REJECTED there — auto-execution callers)', async () => {
    const client = fakeClient();
    client.placeOrder.mockResolvedValue({});
    const r = await new PerUserBrokerSessionFactory().borrow(client, 'C1', (s) => s.placeOrder(ORDER as never, 'k'));
    expect(r).toEqual({ orderId: '', status: 'REJECTED', message: 'Order placement failed' });
  });

  it('is disposed-guarded like placeOrder', async () => {
    let leaked: any;
    await new PerUserBrokerSessionFactory().borrow(fakeClient(), 'C1', async (s) => { leaked = s; });
    await expect(leaked.placeOrderClassified(ORDER, 'axMabc')).rejects.toThrow(/disposed/);
  });
});

describe('cancelOrderClassified — only Angel itself can answer a cancel (SDK interceptor never rejects)', () => {
  const f = () => new PerUserBrokerSessionFactory(() => { throw new Error('must not build a client'); });

  it('sends variety + orderid and classifies an Angel success as ACCEPTED', async () => {
    const client = fakeClient();
    const r = await f().borrow(client, 'C1', (s) => s.cancelOrderClassified('STOPLOSS', 'SL1'));
    expect(client.cancelOrder).toHaveBeenCalledWith({ variety: 'STOPLOSS', orderid: 'SL1' });
    expect(r).toEqual({ status: 'ACCEPTED', message: 'SUCCESS' });
  });

  it('a throw/timeout is UNCERTAIN, never an exception', async () => {
    const client = fakeClient();
    client.cancelOrder.mockRejectedValueOnce(new Error('socket hang up'));
    const r = await f().borrow(client, 'C1', (s) => s.cancelOrderClassified('NORMAL', 'SL1'));
    expect(r).toEqual({ status: 'UNCERTAIN', message: 'socket hang up' });
  });

  it('refuses after disposal', async () => {
    let leaked: any;
    await f().borrow(fakeClient(), 'C1', async (s) => { leaked = s; });
    await expect(leaked.cancelOrderClassified('NORMAL', 'SL1')).rejects.toThrow(/disposed/);
  });

  it.each([
    ['{} (network error / 7 s timeout)', {}, 'UNCERTAIN'],
    ['{status:504} (HTTP error)', { status: 504, message: 'Gateway Time-out' }, 'UNCERTAIN'],
    ['[] (interceptor fault)', [], 'UNCERTAIN'],
    ['undefined', undefined, 'UNCERTAIN'],
    ['status:false with no message/code', { status: false }, 'UNCERTAIN'],
    ['status:true with no orderid', { status: true, message: 'SUCCESS', data: null }, 'UNCERTAIN'],
    ['Angel status:false + message', { status: false, message: 'Order already complete', errorcode: 'AB2003' }, 'REJECTED'],
    ['Angel status:true + orderid', { status: true, message: 'SUCCESS', data: { orderid: 'SL1' } }, 'ACCEPTED'],
  ])('%s → %s', (_n, answer, status) => {
    expect(classifyCancelResponse(answer).status).toBe(status);
  });
});

describe('cancelOrderClassified — a client without cancelOrder', () => {
  it('is UNCERTAIN, never a silent success', async () => {
    const { cancelOrder: _omit, ...client } = fakeClient();
    const f = new PerUserBrokerSessionFactory(() => { throw new Error('must not build a client'); });
    const r = await f.borrow(client as never, 'C1', (s) => s.cancelOrderClassified('NORMAL', 'SL1'));
    expect(r.status).toBe('UNCERTAIN');
  });
});

describe('convertPosition — intraday carry (2026-11-04): the broker answer is never proof', () => {
  const req = {
    exchange: 'NFO', symboltoken: '123', tradingsymbol: 'NIFTY11NOV2524000CE', transactiontype: 'BUY' as const, quantity: 75,
    oldproducttype: 'INTRADAY' as const, newproducttype: 'CARRYFORWARD' as const,
  };
  const borrow = (client: unknown) =>
    new PerUserBrokerSessionFactory(() => { throw new Error('must not build a client'); }).borrow(client as never, 'C1', (s) => s.convertPosition!(req));

  it('sends the Angel params and reads status true as accepted', async () => {
    const client = fakeClient();
    await expect(borrow(client)).resolves.toEqual({ accepted: true, message: 'SUCCESS' });
    expect(client.convertPosition).toHaveBeenCalledWith(expect.objectContaining({ oldproducttype: 'INTRADAY', newproducttype: 'CARRYFORWARD', quantity: '75', type: 'DAY' }));
  });

  it('{} (the SDK swallowing an error), a throw, or no convertPosition → not accepted', async () => {
    const empty = fakeClient();
    empty.convertPosition.mockResolvedValue({});
    expect((await borrow(empty)).accepted).toBe(false);
    const boom = fakeClient();
    boom.convertPosition.mockRejectedValue(new Error('net'));
    expect((await borrow(boom)).accepted).toBe(false);
    const { convertPosition: _omit, ...none } = fakeClient();
    expect((await borrow(none)).accepted).toBe(false);
  });
});

describe('FLOOR_BROKER_SL: stop-loss variety and modifyOrderClassified', () => {
  const f = () => new PerUserBrokerSessionFactory(() => { throw new Error('must not build a client'); });
  const STOP = {
    symbol: 'NIFTY09NOV2624650CE', token: '40009', exchange: 'NFO', side: 'SELL', orderType: 'STOPLOSS', quantity: 130,
    positionType: 'CARRYFORWARD', price: 180.6, triggerPrice: 180.75, variety: 'STOPLOSS',
  } as const;

  it('a STOPLOSS order goes out as variety STOPLOSS / STOPLOSS_LIMIT with its trigger and limit', async () => {
    const client = fakeClient();
    await f().borrow(client, 'C1', (s) => s.placeOrderClassified(STOP as never, 'afSabc'));
    expect(client.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      variety: 'STOPLOSS', ordertype: 'STOPLOSS_LIMIT', price: '180.6', triggerprice: '180.75', ordertag: 'afSabc', producttype: 'CARRYFORWARD',
    }));
  });

  it('an order without a variety is still NORMAL (every existing caller unchanged)', async () => {
    const client = fakeClient();
    await f().borrow(client, 'C1', (s) => s.placeOrderClassified({ ...STOP, variety: undefined, orderType: 'MARKET' } as never, 'axM1'));
    expect(client.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ variety: 'NORMAL', ordertype: 'MARKET' }));
  });

  it('modify sends the full Angel modify body and classifies like a cancel (only Angel answers)', async () => {
    const client = fakeClient();
    const r = await f().borrow(client, 'C1', (s) => s.modifyOrderClassified!({ ...STOP, orderId: 'SL1' } as never));
    expect(client.modifyOrder).toHaveBeenCalledWith({
      variety: 'STOPLOSS', orderid: 'SL1', ordertype: 'STOPLOSS_LIMIT', producttype: 'CARRYFORWARD', duration: 'DAY',
      price: '180.6', triggerprice: '180.75', quantity: '130', tradingsymbol: 'NIFTY09NOV2624650CE', symboltoken: '40009', exchange: 'NFO',
    });
    expect(r).toEqual({ status: 'ACCEPTED', message: 'SUCCESS' });
    client.modifyOrder.mockResolvedValueOnce({});
    expect((await f().borrow(client, 'C1', (s) => s.modifyOrderClassified!({ ...STOP, orderId: 'SL1' } as never))).status).toBe('UNCERTAIN');
    client.modifyOrder.mockRejectedValueOnce(new Error('timeout'));
    expect((await f().borrow(client, 'C1', (s) => s.modifyOrderClassified!({ ...STOP, orderId: 'SL1' } as never))).status).toBe('UNCERTAIN');
  });

  it('a client without modifyOrder is UNCERTAIN; a disposed session refuses', async () => {
    const { modifyOrder: _omit, ...client } = fakeClient();
    expect((await f().borrow(client as never, 'C1', (s) => s.modifyOrderClassified!({ ...STOP, orderId: 'SL1' } as never))).status).toBe('UNCERTAIN');
    let leaked: any;
    await f().borrow(fakeClient(), 'C1', async (s) => { leaked = s; });
    await expect(leaked.modifyOrderClassified({ ...STOP, orderId: 'SL1' })).rejects.toThrow(/disposed/);
  });
});
