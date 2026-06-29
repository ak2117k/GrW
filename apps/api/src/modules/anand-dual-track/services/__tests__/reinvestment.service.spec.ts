import { ReinvestmentService, SWING_PROFIT } from '../reinvestment.service';

function makeRepo() {
  return {
    createReinvestmentLot: jest.fn(async (): Promise<{ id: string } | null> => ({ id: 'lot1' })),
    applyPoolDelta: jest.fn(async () => {}),
    closeReinvestmentLot: jest.fn(async (): Promise<{ transitioned: boolean }> => ({ transitioned: true })),
  };
}

describe('ReinvestmentService', () => {
  it('onSwingTargetHit deploys a ₹20k lot and updates the pool', async () => {
    const repo = makeRepo();
    const svc = new ReinvestmentService(repo as any);
    await svc.onSwingTargetHit({ swingEntryId: 's1', symbol: 'TCS', exitPrice: 110 });

    expect(repo.createReinvestmentLot).toHaveBeenCalledWith({
      symbol: 'TCS', sourceSwingEntryId: 's1', capital: SWING_PROFIT, entryPrice: 110,
    });
    expect(repo.applyPoolDelta).toHaveBeenCalledWith({ harvestedTotal: SWING_PROFIT, deployedActive: SWING_PROFIT });
  });

  it('does not touch the pool when the lot already existed (re-poll)', async () => {
    const repo = makeRepo();
    repo.createReinvestmentLot = jest.fn(async () => null);
    const svc = new ReinvestmentService(repo as any);
    await svc.onSwingTargetHit({ swingEntryId: 's1', symbol: 'TCS', exitPrice: 110 });
    expect(repo.applyPoolDelta).not.toHaveBeenCalled();
  });

  it('closeLot on a win returns capital+profit to idle and books realized pnl', async () => {
    const repo = makeRepo();
    const svc = new ReinvestmentService(repo as any);
    // +10% on ₹20k capital → lotPnl = ₹2,000; idle += 22,000
    await svc.closeLot({ id: 'lot1', capital: SWING_PROFIT, entryPrice: 100 }, 110, 'TARGET_HIT');

    expect(repo.closeReinvestmentLot).toHaveBeenCalledWith('lot1', expect.objectContaining({ status: 'TARGET_HIT', exitPrice: 110, exitReason: 'TARGET_HIT' }));
    expect(repo.applyPoolDelta).toHaveBeenCalledWith({ deployedActive: -SWING_PROFIT, idleBalance: SWING_PROFIT + 2000, realizedPnl: 2000 });
  });

  it('does not touch the pool when the lot was already closed by another poll', async () => {
    const repo = makeRepo();
    repo.closeReinvestmentLot = jest.fn(async () => ({ transitioned: false }));
    const svc = new ReinvestmentService(repo as any);
    await svc.closeLot({ id: 'lot1', capital: SWING_PROFIT, entryPrice: 100 }, 110, 'TARGET_HIT');
    expect(repo.applyPoolDelta).not.toHaveBeenCalled();
  });
});
