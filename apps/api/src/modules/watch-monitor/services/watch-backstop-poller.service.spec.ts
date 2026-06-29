import { Logger } from '@nestjs/common';
import { WatchBackstopPollerService } from './watch-backstop-poller.service';

/**
 * The REST backstop poller prices WS-starved TRADED gated positions and drives
 * their exits through WatchService.onTick, reusing ExitPriceService's
 * fresh-or-surface policy. It must NOT touch positions the WS feed still ticks,
 * and must NEVER fire onTick on a non-fresh price.
 */
describe('WatchBackstopPollerService.backstopOpenPositions', () => {
  let svc: WatchBackstopPollerService;
  let repo: { findAllActive: jest.Mock };
  let watch: { onTick: jest.Mock };
  let exitPrice: { resolveExitPrices: jest.Mock };

  const now = new Date('2026-06-08T05:00:00Z'); // 10:30 IST
  const FIVE_MIN_AGO = new Date(now.getTime() - 5 * 60_000);

  beforeEach(() => {
    jest.useFakeTimers({ now });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    repo = { findAllActive: jest.fn().mockResolvedValue([]) };
    watch = { onTick: jest.fn().mockResolvedValue(undefined) };
    exitPrice = { resolveExitPrices: jest.fn().mockResolvedValue(new Map()) };
    svc = new WatchBackstopPollerService(repo as any, watch as any, exitPrice as any);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('backstops a TRADED entry that is WS-starved (stale lastTickAt) with a fresh price', async () => {
    repo.findAllActive.mockResolvedValue([
      { id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', status: 'TRADED', lastTickAt: FIVE_MIN_AGO },
    ]);
    exitPrice.resolveExitPrices.mockResolvedValue(
      new Map([['11536', { price: 3500, fresh: true, source: 'rest-batch' }]]),
    );

    await svc.backstopOpenPositions();

    expect(exitPrice.resolveExitPrices).toHaveBeenCalledWith('NSE', ['11536']);
    expect(watch.onTick).toHaveBeenCalledTimes(1);
    expect(watch.onTick).toHaveBeenCalledWith('11536', 3500, expect.any(Date));
  });

  it('ignores a TRADED entry the WS feed ticked recently (not starved)', async () => {
    repo.findAllActive.mockResolvedValue([
      { id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', status: 'TRADED', lastTickAt: now },
    ]);

    await svc.backstopOpenPositions();

    expect(exitPrice.resolveExitPrices).not.toHaveBeenCalled();
    expect(watch.onTick).not.toHaveBeenCalled();
  });

  it('does NOT fire onTick when the resolved price is not fresh, and warns', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');
    repo.findAllActive.mockResolvedValue([
      { id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', status: 'TRADED', lastTickAt: FIVE_MIN_AGO },
    ]);
    exitPrice.resolveExitPrices.mockResolvedValue(
      new Map([['11536', { price: 0, fresh: false, source: 'none' }]]),
    );

    await svc.backstopOpenPositions();

    expect(watch.onTick).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('TCS-EQ'));
  });

  it('ignores a WATCHING (not TRADED) entry', async () => {
    repo.findAllActive.mockResolvedValue([
      { id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', status: 'WATCHING', lastTickAt: FIVE_MIN_AGO },
    ]);

    await svc.backstopOpenPositions();

    expect(exitPrice.resolveExitPrices).not.toHaveBeenCalled();
    expect(watch.onTick).not.toHaveBeenCalled();
  });

  it('treats a TRADED entry with no lastTickAt as starved', async () => {
    repo.findAllActive.mockResolvedValue([
      { id: 'w1', symbol: 'INFY-EQ', token: '1594', exchange: 'NSE', status: 'TRADED', lastTickAt: null },
    ]);
    exitPrice.resolveExitPrices.mockResolvedValue(
      new Map([['1594', { price: 1500, fresh: true, source: 'rest-single' }]]),
    );

    await svc.backstopOpenPositions();

    expect(watch.onTick).toHaveBeenCalledWith('1594', 1500, expect.any(Date));
  });

  it('groups starved entries by exchange and resolves each exchange independently', async () => {
    repo.findAllActive.mockResolvedValue([
      { id: 'w1', symbol: 'TCS-EQ', token: '11536', exchange: 'NSE', status: 'TRADED', lastTickAt: FIVE_MIN_AGO },
      { id: 'w2', symbol: 'CRUDE', token: '999', exchange: 'MCX', status: 'TRADED', lastTickAt: FIVE_MIN_AGO },
    ]);
    exitPrice.resolveExitPrices.mockImplementation((exchange: string, tokens: string[]) =>
      Promise.resolve(new Map(tokens.map((t) => [t, { price: 100, fresh: true, source: 'rest-batch' }]))),
    );

    await svc.backstopOpenPositions();

    expect(exitPrice.resolveExitPrices).toHaveBeenCalledWith('NSE', ['11536']);
    expect(exitPrice.resolveExitPrices).toHaveBeenCalledWith('MCX', ['999']);
    expect(watch.onTick).toHaveBeenCalledTimes(2);
  });
});
