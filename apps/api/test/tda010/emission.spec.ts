import { AnandDualTrackService } from '../../src/modules/anand-dual-track/services/anand-dual-track.service';
import { ANAND_PROVENANCE_KEYS } from '../../src/modules/anand-dual-track/dto/public-entry.dto';

/**
 * TDA-010 Task 6 — the createEntries() fan-out tap: best-effort + provenance-safe.
 */
function makeRepo(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    bumpLeadStat: jest.fn(async () => {}),
    findActiveTradedBySymbol: jest.fn(async () => null),
    hasTargetHitTodayBySymbol: jest.fn(async () => false),
    hasLossTodayBySymbol: jest.fn(async () => false),
    createIntradayEntry: jest.fn(async () => ({
      id: 'i1', symbol: 'TCS', token: '11536', entryPrice: 3500,
      enteredAt: new Date('2026-07-02T04:00:00Z'), targetPct: 5, stopPct: 5, status: 'TRADED',
      // provenance columns that MUST NOT leak into a fan-out job:
      scannerName: '__LEAK_scanner__', scoreBreakdown: [{ name: '__LEAK__' }], alertId: 'al_1',
    })),
    createSwingEntry: jest.fn(async () => ({
      id: 's1', symbol: 'TCS', token: '11536', entryPrice: 3500,
      enteredAt: new Date('2026-07-02T04:00:00Z'), targetPct: 10, stopPct: 10, status: 'TRADED',
      scannerName: '__LEAK_scanner__', scoreBreakdown: [{ name: '__LEAK__' }], alertId: 'al_1',
    })),
    ...overrides,
  };
}

const input = { alertId: 'a1', symbol: 'TCS', token: '11536', hitPrice: 3500, scoreBreakdown: [{ name: 'RSI' }] };

describe('AnandDualTrackService fan-out emission', () => {
  it('enqueues one provenance-safe PublicSignal per successful segment insert', async () => {
    const repo = makeRepo();
    const fanout = { enqueueFanout: jest.fn(async () => {}) };
    const service = new AnandDualTrackService(repo as any, fanout as any);

    await service.createEntries(input);

    expect(fanout.enqueueFanout).toHaveBeenCalledTimes(2);
    const [intradaySig] = fanout.enqueueFanout.mock.calls[0];
    const [swingSig] = fanout.enqueueFanout.mock.calls[1];

    expect(intradaySig).toMatchObject({
      entryId: 'i1', symbol: 'TCS', segment: 'INTRADAY', side: 'BUY', entryPrice: 3500, targetPct: 5, stopPct: 5, token: '11536',
    });
    expect(swingSig).toMatchObject({ entryId: 's1', segment: 'SWING', targetPct: 10 });

    const json = JSON.stringify(fanout.enqueueFanout.mock.calls);
    for (const k of [...ANAND_PROVENANCE_KEYS, 'alertId']) expect(json).not.toContain(k);
    expect(json).not.toContain('__LEAK_scanner__');
  });

  it('does not enqueue when an insert throws, and never propagates (best-effort)', async () => {
    const repo = makeRepo({
      createIntradayEntry: jest.fn(async () => { throw new Error('DB error'); }),
    });
    const fanout = { enqueueFanout: jest.fn(async () => {}) };
    const service = new AnandDualTrackService(repo as any, fanout as any);

    await expect(service.createEntries(input)).resolves.not.toThrow();
    // intraday insert failed → no intraday emit; swing succeeded → exactly one emit
    expect(fanout.enqueueFanout).toHaveBeenCalledTimes(1);
    expect(fanout.enqueueFanout.mock.calls[0][0]).toMatchObject({ segment: 'SWING' });
  });

  it('a fan-out enqueue failure never breaks createEntries', async () => {
    const repo = makeRepo();
    const fanout = { enqueueFanout: jest.fn(async () => { throw new Error('queue down'); }) };
    const service = new AnandDualTrackService(repo as any, fanout as any);

    await expect(service.createEntries(input)).resolves.not.toThrow();
    expect(repo.createIntradayEntry).toHaveBeenCalled();
    expect(repo.createSwingEntry).toHaveBeenCalled();
  });

  it('works with no fan-out service bound (optional dependency)', async () => {
    const repo = makeRepo();
    const service = new AnandDualTrackService(repo as any);
    await expect(service.createEntries(input)).resolves.not.toThrow();
  });
});
