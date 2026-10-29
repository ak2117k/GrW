import { SignalOiCheckService, type OiCheckRequest } from './signal-oi-check.service';

const req: OiCheckRequest = {
  decisionId: 'dec_1',
  signal: { underlying: 'CRUDEOIL', instrumentKind: 'CE', strike: 5400 },
  plan: { exchange: 'MCX', side: 'BUY', ltp: 120 },
  expiry: '2026-11-17',
  at: new Date('2026-10-29T08:41:00Z'),
};

function makeRepo(o: Partial<Record<string, jest.Mock>> = {}) {
  return {
    recordOiCheck: jest.fn(async () => undefined),
    nearestFuture: jest.fn(async () => ({ instrumentId: 'FUT1', symbol: 'CRUDEOIL19NOV26FUT', exchange: 'MCX', token: '999' })),
    cashRef: jest.fn(async () => null),
    optionExpiries: jest.fn(async () => ['2026-11-10', '2026-11-17']),
    optionContracts: jest.fn(async () => [{ instrumentId: 'CE5400', strike: 5400, optionType: 'CE' }]),
    oiRows: jest.fn(async () => [{ instrumentId: 'CE5400', oi: 1, at: new Date('2026-10-29T08:39:00Z') }]),
    chainSpotSince: jest.fn(async () => null),
    minuteCloses: jest.fn(async () => [{ at: new Date('2026-10-29T08:40:00Z'), close: 5412 }]),
    oiLtps: jest.fn(async () => []),
    ...o,
  };
}

describe('SignalOiCheckService', () => {
  it('builds the input from the database: traded expiry first, MCX session 09:00 IST, centre from the future 1m close', async () => {
    const repo = makeRepo();
    const i = await new SignalOiCheckService(repo as never).input(req);
    expect(i.want).toBe('BULLISH');
    expect(i.sessionStart.toISOString()).toBe('2026-10-29T03:30:00.000Z');
    expect(i.chain).toMatchObject({ expiry: '2026-11-17', center: 5412, centerSource: 'candles_1m CRUDEOIL19NOV26FUT' });
    expect((repo.optionContracts.mock.calls[0] as unknown[])[1]).toBe('2026-11-17');
    // Futures price: no snapshot LTPs → the future's own 1m closes.
    expect(i.futures).toMatchObject({ instrumentId: 'FUT1', priceSource: 'candles_1m CRUDEOIL19NOV26FUT' });
  });

  it('a failing read is stored as NO_DATA with the error, never thrown', async () => {
    const repo = makeRepo({ nearestFuture: jest.fn(async () => { throw new Error('db down'); }) });
    const c = await new SignalOiCheckService(repo as never).record(req);
    expect(c).toMatchObject({ verdict: 'NO_DATA', source: 'NONE', error: 'db down', want: 'BULLISH' });
    expect(repo.recordOiCheck).toHaveBeenCalledWith('dec_1', expect.objectContaining({ verdict: 'NO_DATA' }));
    // Even the store failing does not throw.
    const r2 = makeRepo({ recordOiCheck: jest.fn(async () => { throw new Error('write failed'); }) });
    await expect(new SignalOiCheckService(r2 as never).record(req)).resolves.toMatchObject({ verdict: expect.any(String) });
  });
});
