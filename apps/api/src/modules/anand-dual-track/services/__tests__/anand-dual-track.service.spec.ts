import { Test } from '@nestjs/testing';
import { AnandDualTrackService } from '../anand-dual-track.service';
import { AnandDualTrackRepository } from '../../repositories/anand-dual-track.repository';

describe('AnandDualTrackService', () => {
  let service: AnandDualTrackService;
  let repo: {
    createIntradayEntry: jest.Mock;
    createSwingEntry: jest.Mock;
    findActiveTradedBySymbol: jest.Mock;
    bumpLeadStat: jest.Mock;
    hasTargetHitTodayBySymbol: jest.Mock;
    hasLossTodayBySymbol: jest.Mock;
  };

  beforeEach(async () => {
    repo = {
      createIntradayEntry: jest.fn().mockResolvedValue({ id: 'i1' }),
      createSwingEntry: jest.fn().mockResolvedValue({ id: 's1' }),
      findActiveTradedBySymbol: jest.fn().mockResolvedValue(null),
      bumpLeadStat: jest.fn().mockResolvedValue(undefined),
      hasTargetHitTodayBySymbol: jest.fn().mockResolvedValue(false),
      hasLossTodayBySymbol: jest.fn().mockResolvedValue(false),
    };

    const mod = await Test.createTestingModule({
      providers: [
        AnandDualTrackService,
        { provide: AnandDualTrackRepository, useValue: repo },
      ],
    }).compile();

    service = mod.get(AnandDualTrackService);
  });

  it('createEntries calls both repo methods with same input', async () => {
    const input = {
      alertId: 'a1', symbol: 'RELIANCE', token: '2885', hitPrice: 2500, scoreBreakdown: [{ name: 'RSI', passed: true }],
    };
    await service.createEntries(input);
    expect(repo.findActiveTradedBySymbol).toHaveBeenCalledWith('intraday', 'RELIANCE');
    expect(repo.findActiveTradedBySymbol).toHaveBeenCalledWith('swing', 'RELIANCE');
    expect(repo.createIntradayEntry).toHaveBeenCalledWith({
      symbol: 'RELIANCE', token: '2885', entryPrice: 2500, alertId: 'a1', scoreBreakdown: [{ name: 'RSI', passed: true }],
    });
    expect(repo.createSwingEntry).toHaveBeenCalledWith({
      symbol: 'RELIANCE', token: '2885', entryPrice: 2500, alertId: 'a1', scoreBreakdown: [{ name: 'RSI', passed: true }],
    });
  });

  it('createEntries does not throw if one insert fails', async () => {
    repo.createSwingEntry.mockRejectedValue(new Error('DB error'));
    await expect(service.createEntries({
      alertId: 'a1', symbol: 'TCS', token: '11536', hitPrice: 3500, scoreBreakdown: null,
    })).resolves.not.toThrow();
    expect(repo.createIntradayEntry).toHaveBeenCalled();
  });

  it('skips intraday create if active TRADED entry exists for symbol', async () => {
    repo.findActiveTradedBySymbol.mockImplementation((track: string) =>
      track === 'intraday' ? Promise.resolve({ id: 'existing-i' }) : Promise.resolve(null),
    );
    await service.createEntries({ alertId: 'a1', symbol: 'INFY', token: '1594', hitPrice: 1700, scoreBreakdown: null });
    expect(repo.createIntradayEntry).not.toHaveBeenCalled();
    expect(repo.createSwingEntry).toHaveBeenCalled();
  });

  it('skips swing create if active TRADED entry exists for symbol', async () => {
    repo.findActiveTradedBySymbol.mockImplementation((track: string) =>
      track === 'swing' ? Promise.resolve({ id: 'existing-s' }) : Promise.resolve(null),
    );
    await service.createEntries({ alertId: 'a1', symbol: 'INFY', token: '1594', hitPrice: 1700, scoreBreakdown: null });
    expect(repo.createIntradayEntry).toHaveBeenCalled();
    expect(repo.createSwingEntry).not.toHaveBeenCalled();
  });

  it('skips both creates if active TRADED entries exist for both tracks', async () => {
    repo.findActiveTradedBySymbol.mockResolvedValue({ id: 'existing' });
    await service.createEntries({ alertId: 'a1', symbol: 'HDFCBANK', token: '1333', hitPrice: 1600, scoreBreakdown: null });
    expect(repo.createIntradayEntry).not.toHaveBeenCalled();
    expect(repo.createSwingEntry).not.toHaveBeenCalled();
  });
});

function makeRepo(overrides: Partial<any> = {}) {
  return {
    bumpLeadStat: jest.fn(async () => {}),
    findActiveTradedBySymbol: jest.fn(async () => null),
    hasTargetHitTodayBySymbol: jest.fn(async () => false),
    hasLossTodayBySymbol: jest.fn(async () => false),
    createIntradayEntry: jest.fn(async () => ({ id: 'i1' })),
    createSwingEntry: jest.fn(async () => ({ id: 's1' })),
    ...overrides,
  };
}

const leadGuardInput = { alertId: 'a1', symbol: 'TCS', token: 't1', hitPrice: 100, scoreBreakdown: null };

describe('AnandDualTrackService.createEntries (lead + same-day guard)', () => {
  it('bumps the swing lead stat on every fire', async () => {
    const repo = makeRepo();
    await new AnandDualTrackService(repo as any).createEntries(leadGuardInput);
    expect(repo.bumpLeadStat).toHaveBeenCalledWith('swing', 'TCS');
  });

  it('skips both tracks when that track hit target today', async () => {
    const repo = makeRepo({ hasTargetHitTodayBySymbol: jest.fn(async () => true) });
    await new AnandDualTrackService(repo as any).createEntries(leadGuardInput);
    expect(repo.createIntradayEntry).not.toHaveBeenCalled();
    expect(repo.createSwingEntry).not.toHaveBeenCalled();
    // lead stat still bumped
    expect(repo.bumpLeadStat).toHaveBeenCalledWith('swing', 'TCS');
  });

  it('still creates entries on a normal fire', async () => {
    const repo = makeRepo();
    await new AnandDualTrackService(repo as any).createEntries(leadGuardInput);
    expect(repo.createIntradayEntry).toHaveBeenCalled();
    expect(repo.createSwingEntry).toHaveBeenCalled();
  });

  it('skips a track when that symbol already made a LOSS today (no same-day re-entry after a loss)', async () => {
    const repo = makeRepo({ hasLossTodayBySymbol: jest.fn(async () => true) });
    await new AnandDualTrackService(repo as any).createEntries(leadGuardInput);
    expect(repo.createIntradayEntry).not.toHaveBeenCalled();
    expect(repo.createSwingEntry).not.toHaveBeenCalled();
    expect(repo.hasLossTodayBySymbol).toHaveBeenCalledWith('intraday', 'TCS');
    expect(repo.hasLossTodayBySymbol).toHaveBeenCalledWith('swing', 'TCS');
  });
});
