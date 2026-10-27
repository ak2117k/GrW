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

describe('MarketDataRepository.getInstrumentBySymbol', () => {
  it('prefers the INDEX row for an NSE index symbol (the master refresh also writes a 26xxx row with no candles)', async () => {
    const index = { symbol: 'BANKNIFTY', token: '99926009', segment: 'INDEX' };
    const findFirst = jest.fn().mockImplementation(({ where }) => Promise.resolve(where.segment === 'INDEX' ? index : { symbol: 'BANKNIFTY', token: '26009', segment: 'NSE' }));
    const repo = new MarketDataRepository({ instrument: { findFirst } } as never);
    await expect(repo.getInstrumentBySymbol('BANKNIFTY', 'NSE')).resolves.toBe(index);
  });

  it('falls back to the plain match when there is no INDEX row, and never asks for one for a suffixed cash symbol', async () => {
    const row = { symbol: 'KEI-EQ', token: '13310' };
    const findFirst = jest.fn().mockImplementation(({ where }) => Promise.resolve(where.segment ? null : row));
    const repo = new MarketDataRepository({ instrument: { findFirst } } as never);
    await expect(repo.getInstrumentBySymbol('KEI-EQ', 'NSE')).resolves.toBe(row);
    expect(findFirst).toHaveBeenCalledTimes(1);
    await expect(repo.getInstrumentBySymbol('RELIANCE', 'NSE')).resolves.toBe(row);
    expect(findFirst).toHaveBeenLastCalledWith({ where: { symbol: 'RELIANCE', exchange: 'NSE' } });
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
