/**
 * Kill-switch square-off for the Anand dual track (CLAUDE.md §9: the kill switch
 * squares off ALL positions). Open intraday + swing entries and open
 * reinvestment lots are closed at a FRESH exit price; anything without one is
 * left open and reported as skipped (the cascade turns that into FAILED).
 */
import { AnandPriceMonitorService } from './anand-price-monitor.service';
import { ReinvestmentService } from './reinvestment.service';

const fresh = (price: number) => ({ price, fresh: true, source: 'hub' });

function setup(opts: {
  intraday?: Array<{ id: string; symbol: string; token: string | null; entryPrice: number }>;
  swing?: Array<{ id: string; symbol: string; token: string | null; entryPrice: number }>;
  lots?: Array<{ id: string; symbol: string; capital: number; entryPrice: number }>;
  prices?: Record<string, number>;
} = {}) {
  const prices = new Map(Object.entries(opts.prices ?? {}).map(([t, p]) => [t, fresh(p)]));
  const repo = {
    listWatchingIntraday: jest.fn(async () => opts.intraday ?? []),
    listWatchingSwing: jest.fn(async () => opts.swing ?? []),
    listOpenReinvestmentLots: jest.fn(async () => opts.lots ?? []),
    resolveTokens: jest.fn(async (symbols: string[]) => new Map(symbols.map((s) => [s, `tok-${s}`]))),
    closeOpenIntraday: jest.fn(async () => true),
    closeOpenSwing: jest.fn(async () => true),
    closeReinvestmentLot: jest.fn(async () => ({ transitioned: true })),
    applyPoolDelta: jest.fn(async () => undefined),
    updateIntradayStatus: jest.fn(),
    updateSwingStatus: jest.fn(),
  };
  const exitPrice = { resolveExitPrices: jest.fn(async (_ex: string, tokens: string[]) => new Map(tokens.filter((t) => prices.has(t)).map((t) => [t, prices.get(t)!]))) };
  const reinvest = new ReinvestmentService(repo as never);
  const svc = new AnandPriceMonitorService(repo as never, {} as never, reinvest, exitPrice as never);
  return { svc, repo, exitPrice };
}

describe('AnandPriceMonitorService.squareOffAll (kill switch)', () => {
  it('closes every open intraday + swing entry and reinvestment lot at the fresh price, as SQUARED_OFF', async () => {
    const { svc, repo } = setup({
      intraday: [{ id: 'i1', symbol: 'TCS', token: 't1', entryPrice: 100 }],
      swing: [{ id: 's1', symbol: 'INFY', token: 't2', entryPrice: 200 }],
      lots: [{ id: 'l1', symbol: 'WIPRO', capital: 20000, entryPrice: 50 }],
      prices: { t1: 101, t2: 190, 'tok-WIPRO': 55 },
    });
    const r = await svc.squareOffAll('core kill switch: panic');
    expect(r).toEqual({ attempted: 3, closed: 3, skipped: 0, errors: 0 });
    expect(repo.closeOpenIntraday).toHaveBeenCalledWith('i1', expect.objectContaining({ exitPrice: 101, exitReason: 'core kill switch: panic' }));
    expect(repo.closeOpenSwing).toHaveBeenCalledWith('s1', expect.objectContaining({ exitPrice: 190, exitReason: 'core kill switch: panic' }));
    expect(repo.closeReinvestmentLot).toHaveBeenCalledWith('l1', expect.objectContaining({ status: 'SQUARED_OFF', exitPrice: 55 }));
    expect(repo.applyPoolDelta).toHaveBeenCalledTimes(1);
    // never the unguarded status writers (they could overwrite a concurrent TARGET_HIT)
    expect(repo.updateIntradayStatus).not.toHaveBeenCalled();
    expect(repo.updateSwingStatus).not.toHaveBeenCalled();
  });

  it('a position without a fresh price stays open and is counted as skipped', async () => {
    const { svc, repo } = setup({
      intraday: [{ id: 'i1', symbol: 'TCS', token: 't1', entryPrice: 100 }, { id: 'i2', symbol: 'X', token: null, entryPrice: 10 }],
      swing: [{ id: 's1', symbol: 'INFY', token: 't2', entryPrice: 200 }],
      prices: { t1: 101 },
    });
    const r = await svc.squareOffAll('stop');
    expect(r).toEqual({ attempted: 3, closed: 1, skipped: 2, errors: 0 });
    expect(repo.closeOpenSwing).not.toHaveBeenCalled();
  });

  it('a row that fails to close is counted as an error and the rest still close', async () => {
    const { svc, repo } = setup({
      intraday: [{ id: 'i1', symbol: 'TCS', token: 't1', entryPrice: 100 }],
      swing: [{ id: 's1', symbol: 'INFY', token: 't2', entryPrice: 200 }],
      prices: { t1: 101, t2: 190 },
    });
    repo.closeOpenIntraday.mockRejectedValueOnce(new Error('db down'));
    const r = await svc.squareOffAll('stop');
    expect(r).toEqual({ attempted: 2, closed: 1, skipped: 0, errors: 1 });
    expect(repo.closeOpenSwing).toHaveBeenCalledTimes(1);
  });

  it('a row the poller already closed (guard did not transition) is not double-counted', async () => {
    const { svc, repo } = setup({ intraday: [{ id: 'i1', symbol: 'TCS', token: 't1', entryPrice: 100 }], prices: { t1: 101 } });
    repo.closeOpenIntraday.mockResolvedValueOnce(false);
    expect(await svc.squareOffAll('stop')).toEqual({ attempted: 1, closed: 1, skipped: 0, errors: 0 });
  });

  it('nothing open → nothing to do', async () => {
    const { svc, exitPrice } = setup();
    expect(await svc.squareOffAll('stop')).toEqual({ attempted: 0, closed: 0, skipped: 0, errors: 0 });
    expect(exitPrice.resolveExitPrices).not.toHaveBeenCalled();
  });
});
