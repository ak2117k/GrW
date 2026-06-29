import { Test } from '@nestjs/testing';
import { StrikeSelectorService } from './strike-selector.service';
import { OptionStrikeSelectorService } from '../../options-chain/services/option-strike-selector.service';
import { OptionsChainService } from '../../options-chain/services/options-chain.service';

describe('StrikeSelectorService', () => {
  let svc: StrikeSelectorService;
  let inner: { selectBestStrike: jest.Mock };
  let chain: { getExpiries: jest.Mock; getOptionsChainWithSpot: jest.Mock };

  beforeEach(async () => {
    inner = { selectBestStrike: jest.fn() };
    chain = { getExpiries: jest.fn(), getOptionsChainWithSpot: jest.fn().mockResolvedValue({ chain: [], spotPrice: 4000 }) };
    const mod = await Test.createTestingModule({
      providers: [
        StrikeSelectorService,
        { provide: OptionStrikeSelectorService, useValue: inner },
        { provide: OptionsChainService, useValue: chain },
      ],
    }).compile();
    svc = mod.get(StrikeSelectorService);
  });

  it('returns null when no expiries are available', async () => {
    chain.getExpiries.mockResolvedValue([]);
    const r = await svc.pick({ symbol: 'TCS', side: 'BUY', underlyingPrice: 4000 });
    expect(r).toBeNull();
  });

  it('uses current-month expiry when > 7 days away', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-13'));
    const current = new Date('2026-05-27').toISOString();
    const next = new Date('2026-06-24').toISOString();
    chain.getExpiries.mockResolvedValue([current, next]);
    inner.selectBestStrike.mockResolvedValue({
      strikePrice: 4000, side: 'CE', expiry: current, ltp: 50,
      gamma: 0.05, theta: -1, delta: 0.5, vega: 1, iv: 0.2, volume: 5000,
      oi: 1000, oiChange: 100, score: 0.7,
      scoreBreakdown: { gamma: 0.8, volume: 0.6, oiChange: 0.5, iv: 0.3 },
      spotPrice: 4000, reason: 'best',
    });
    const r = await svc.pick({ symbol: 'TCS', side: 'BUY', underlyingPrice: 4000 });
    expect(r?.optionsType).toBe('CE');
    expect(r?.optionsStrike).toBe(4000);
    expect(inner.selectBestStrike).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'CE', expiry: current }),
    );
    jest.useRealTimers();
  });

  it('skips current-month and picks next-month when < 7 days from expiry', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-22'));
    const current = new Date('2026-05-27').toISOString();
    const next = new Date('2026-06-24').toISOString();
    chain.getExpiries.mockResolvedValue([current, next]);
    inner.selectBestStrike.mockResolvedValue({
      strikePrice: 4000, side: 'PE', expiry: next, ltp: 50, gamma: 0.05,
      theta: -1, delta: -0.5, vega: 1, iv: 0.2, volume: 5000, oi: 1000,
      oiChange: 100, score: 0.7,
      scoreBreakdown: { gamma: 0.8, volume: 0.6, oiChange: 0.5, iv: 0.3 },
      spotPrice: 4000, reason: 'best',
    });
    const r = await svc.pick({ symbol: 'TCS', side: 'SELL', underlyingPrice: 4000 });
    expect(r?.optionsType).toBe('PE');
    expect(inner.selectBestStrike).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'PE', expiry: next }),
    );
    jest.useRealTimers();
  });

  it('returns null when inner selector returns null (illiquid)', async () => {
    chain.getExpiries.mockResolvedValue([new Date('2026-05-27').toISOString()]);
    inner.selectBestStrike.mockResolvedValue(null);
    const r = await svc.pick({ symbol: 'TCS', side: 'BUY', underlyingPrice: 4000 });
    expect(r).toBeNull();
  });
});
