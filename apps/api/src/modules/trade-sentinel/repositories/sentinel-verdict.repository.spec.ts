import { SentinelVerdictRepository } from './sentinel-verdict.repository';

describe('SentinelVerdictRepository', () => {
  const create = jest.fn();
  const findMany = jest.fn();
  const prisma = { sentinelVerdict: { create, findMany } } as any;
  const repo = new SentinelVerdictRepository(prisma);

  beforeEach(() => jest.clearAllMocks());

  it('stores the packet verbatim alongside the verdict', async () => {
    const packet = { position: { symbol: 'INFY' }, oi: { available: false, reason: 'no chain' } };
    create.mockResolvedValue({ id: 'v1' });

    await repo.record({
      userId: 'u1',
      trackerId: 't1',
      symbol: 'INFY',
      verdict: 'HOLD',
      confidence: 'high',
      thesisStatus: 'INTACT',
      recoveryAvailable: true,
      reason: 'structure holding',
      evidence: ['structure.nearestSupport'],
      invalidationPoint: 'close below 1450',
      reviewInSec: 300,
      packet,
      promptVersion: 'v1',
      triggeredBy: ['heartbeat'],
      netPnl: 1200,
      greenFloor: 1455,
    });

    // Every mapped field, spelled out: `record` hand-maps 16 columns, which is
    // exactly the shape where a transposition (`reason: input.symbol`) hides.
    expect(create).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        trackerId: 't1',
        symbol: 'INFY',
        verdict: 'HOLD',
        confidence: 'high',
        thesisStatus: 'INTACT',
        recoveryAvailable: true,
        reason: 'structure holding',
        evidence: ['structure.nearestSupport'],
        invalidationPoint: 'close below 1450',
        reviewInSec: 300,
        packet,
        promptVersion: 'v1',
        triggeredBy: ['heartbeat'],
        netPnl: 1200,
        greenFloor: 1455,
      },
    });

    // Reference identity, not structural equality. The assertion above would pass
    // against a deep clone or a key reorder; verbatim passthrough is the property
    // the replay harness depends on, so it gets its own `toBe`.
    expect(create.mock.calls[0][0].data.packet).toBe(packet);
  });

  it('returns the most recent verdicts for one tracker, newest first', async () => {
    findMany.mockResolvedValue([]);
    await repo.recentForTracker('t1', 3);
    expect(findMany).toHaveBeenCalledWith({
      where: { trackerId: 't1' },
      orderBy: { createdAt: 'desc' },
      take: 3,
    });
  });
});
