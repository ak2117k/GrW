import { of } from 'rxjs';
import { CommodityRollService } from './commodity-roll.service';

/**
 * A minimal ScripMaster containing one live front-month GOLD FUTCOM. Expiry is
 * far in the future so pickFrontMonth() always accepts it regardless of when
 * the test runs.
 */
const MASTER = [
  {
    exch_seg: 'MCX',
    instrumenttype: 'FUTCOM',
    name: 'GOLD',
    symbol: 'GOLD05AUG26FUT',
    token: '466583',
    expiry: '31DEC2099',
    lotsize: '100',
  },
];

function makeService() {
  const http = { get: jest.fn().mockReturnValue(of({ data: MASTER })) };
  const prisma = {
    instrument: {
      findFirst: jest.fn().mockResolvedValue(null), // no row yet → seed path
      upsert: jest.fn().mockResolvedValue({ id: 'inst-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    candle: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  const adapter = { getHistoricalData: jest.fn().mockResolvedValue([]) };
  const repository = { upsertCandle: jest.fn().mockResolvedValue(undefined) };
  const svc = new CommodityRollService(
    http as never,
    prisma as never,
    adapter as never,
    repository as never,
    null,
    null,
  );
  return { svc, http, prisma, adapter, repository };
}

describe('CommodityRollService — first-time seed (no DB row)', () => {
  it('CREATES the instrument row at the front-month token when none exists', async () => {
    const { svc, prisma } = makeService();

    const results = await svc.runRoll({ symbols: ['GOLD'] });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      symbol: 'GOLD',
      status: 'CREATED',
      newToken: '466583',
      newContractSymbol: 'GOLD05AUG26FUT',
    });
    // Row is created (not just updated) with the MCX commodity shape.
    expect(prisma.instrument.upsert).toHaveBeenCalledTimes(1);
    const arg = (prisma.instrument.upsert as jest.Mock).mock.calls[0][0];
    expect(arg.create).toMatchObject({
      symbol: 'GOLD',
      token: '466583',
      exchange: 'MCX',
      segment: 'COMMODITY',
    });
  });

  it('dry run reports WOULD_CREATE and writes nothing', async () => {
    const { svc, prisma } = makeService();

    const results = await svc.runRoll({ symbols: ['GOLD'], dryRun: true });

    expect(results[0]).toMatchObject({ symbol: 'GOLD', status: 'WOULD_CREATE', newToken: '466583' });
    expect(prisma.instrument.upsert).not.toHaveBeenCalled();
  });
});
