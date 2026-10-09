import { MarketDataRepository } from './market-data.repository';

describe('MarketDataRepository.getInstrumentByToken', () => {
  it('filters by exchange when given one (tokens collide across segments), and not otherwise', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const repo = new MarketDataRepository({ instrument: { findFirst } } as never);
    await repo.getInstrumentByToken('35001', 'NFO');
    expect(findFirst).toHaveBeenLastCalledWith({ where: { token: '35001', exchange: 'NFO', isActive: true } });
    await repo.getInstrumentByToken('35001');
    expect(findFirst).toHaveBeenLastCalledWith({ where: { token: '35001', isActive: true } });
  });
});

describe('MarketDataRepository.getNearestFuture', () => {
  it('matches the master NAME exactly (so CRUDEOIL never picks CRUDEOILM), futures only, nearest expiry on or after the cut-off', async () => {
    const findFirst = jest.fn().mockResolvedValue({ token: '472789', symbol: 'CRUDEOIL19OCT26FUT', exchange: 'MCX' });
    const repo = new MarketDataRepository({ instrument: { findFirst } } as never);
    const cutoff = new Date(2026, 9, 9);

    const r = await repo.getNearestFuture('CRUDEOIL', 'MCX', cutoff);

    expect(r).toEqual({ token: '472789', symbol: 'CRUDEOIL19OCT26FUT', exchange: 'MCX' });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        name: 'CRUDEOIL',
        exchange: 'MCX',
        isActive: true,
        optionType: null,
        symbol: { endsWith: 'FUT' },
        expiry: { gte: cutoff },
      },
      orderBy: { expiry: 'asc' },
    });
  });
});
