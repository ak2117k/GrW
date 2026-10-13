/**
 * Kill-switch square-off for the breakout-swing track (CLAUDE.md §9). Every
 * TRADED entry is closed at a FRESH exit price; one without a price stays open
 * and is counted as skipped (the cascade reports it FAILED). QUEUED resting
 * limits are not positions; their fill is already blocked by the kill gate.
 */
import { BreakoutSwingPollerService } from './breakout-swing-poller.service';

function setup(traded: Array<{ id: string; symbol: string; token: string | null; entryPrice: number | null }>, prices: Record<string, number>) {
  const repo = {
    listTraded: jest.fn(async () => traded),
    listQueued: jest.fn(async () => []),
    closeTraded: jest.fn(async () => true),
    updateStatus: jest.fn(),
  };
  const exitPrice = {
    resolveExitPrices: jest.fn(async (_ex: string, tokens: string[]) =>
      new Map(tokens.filter((t) => t in prices).map((t) => [t, { price: prices[t], fresh: true, source: 'hub' }]))),
  };
  return { svc: new BreakoutSwingPollerService(repo as never, exitPrice as never), repo };
}

describe('BreakoutSwingPollerService.squareOffOpenPositions (kill switch)', () => {
  it('closes every TRADED entry at the fresh price as SQUARED_OFF through the guarded close', async () => {
    const { svc, repo } = setup(
      [{ id: 'b1', symbol: 'TCS', token: 't1', entryPrice: 100 }, { id: 'b2', symbol: 'INFY', token: 't2', entryPrice: 50 }],
      { t1: 104, t2: 48 },
    );
    const r = await svc.squareOffOpenPositions('core kill switch: panic');
    expect(r).toEqual({ attempted: 2, closed: 2, skipped: 0, errors: 0 });
    expect(repo.closeTraded).toHaveBeenCalledWith('b1', expect.objectContaining({ status: 'SQUARED_OFF', exitPrice: 104, exitReason: 'core kill switch: panic' }));
    expect(repo.closeTraded).toHaveBeenCalledWith('b2', expect.objectContaining({ exitPrice: 48 }));
    expect(repo.updateStatus).not.toHaveBeenCalled();
    expect(repo.listQueued).not.toHaveBeenCalled();
  });

  it('no fresh price (or no token) → left open, counted skipped', async () => {
    const { svc, repo } = setup(
      [{ id: 'b1', symbol: 'TCS', token: 't1', entryPrice: 100 }, { id: 'b2', symbol: 'X', token: null, entryPrice: 10 }],
      {},
    );
    expect(await svc.squareOffOpenPositions('stop')).toEqual({ attempted: 2, closed: 0, skipped: 2, errors: 0 });
    expect(repo.closeTraded).not.toHaveBeenCalled();
  });

  it('a failing close is an error; the rest still close', async () => {
    const { svc, repo } = setup(
      [{ id: 'b1', symbol: 'TCS', token: 't1', entryPrice: 100 }, { id: 'b2', symbol: 'INFY', token: 't2', entryPrice: 50 }],
      { t1: 104, t2: 48 },
    );
    repo.closeTraded.mockRejectedValueOnce(new Error('db down'));
    expect(await svc.squareOffOpenPositions('stop')).toEqual({ attempted: 2, closed: 1, skipped: 0, errors: 1 });
  });
});
