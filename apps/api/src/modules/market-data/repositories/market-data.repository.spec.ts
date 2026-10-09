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
