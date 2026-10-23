import { SentinelVerdictRepository, type RecordVerdictInput } from './sentinel-verdict.repository';

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

describe('SentinelVerdictRepository — overnight review rows', () => {
  const create = jest.fn();
  const findFirst = jest.fn();
  const prisma = { sentinelVerdict: { create, findFirst } } as any;
  const repo = new SentinelVerdictRepository(prisma);

  beforeEach(() => jest.clearAllMocks());

  it('stores an overnight verdict in the same table, with the window kind and tag in triggeredBy', async () => {
    create.mockResolvedValue({ id: 'v2' });
    await repo.record({
      userId: 'u1',
      trackerId: 't1',
      symbol: 'NIFTY13OCT2625000CE',
      verdict: 'TIGHTEN_AT_OPEN',
      confidence: 'medium',
      thesisStatus: 'WEAKENING',
      recoveryAvailable: true,
      reason: 'OVERNIGHT RISK: theta\nOPEN PLAN: exit below 24950',
      evidence: ['overnight.decay'],
      invalidationPoint: 'open above 25150',
      reviewInSec: 63000,
      packet: { overnight: {} },
      promptVersion: 'o1/t1',
      triggeredBy: ['OVERNIGHT_REVIEW', 'window:OVERNIGHT_REVIEW:EQUITY:2026-10-12'],
      netPnl: -1590,
      greenFloor: 142.4,
    });
    expect(create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        verdict: 'TIGHTEN_AT_OPEN',
        triggeredBy: ['OVERNIGHT_REVIEW', 'window:OVERNIGHT_REVIEW:EQUITY:2026-10-12'],
      }),
    );
  });

  it('answers "already judged in this window" from the stored tag, per position', async () => {
    findFirst.mockResolvedValueOnce({ id: 'v2' }).mockResolvedValueOnce(null);
    await expect(repo.hasWindowVerdict('t1', 'window:OVERNIGHT_REVIEW:EQUITY:2026-10-12')).resolves.toBe(true);
    await expect(repo.hasWindowVerdict('t2', 'window:OVERNIGHT_REVIEW:EQUITY:2026-10-12')).resolves.toBe(false);
    expect(findFirst).toHaveBeenCalledWith({
      where: { trackerId: 't1', triggeredBy: { array_contains: ['window:OVERNIGHT_REVIEW:EQUITY:2026-10-12'] } },
      select: { id: true },
    });
  });
});

describe('SentinelVerdictRepository — the live cycle never mistakes an overnight row for its last look', () => {
  const findMany = jest.fn().mockResolvedValue([]);
  const repo = new SentinelVerdictRepository({ sentinelVerdict: { findMany } } as any);

  it('liveOnly excludes rows written by any overnight window, the 09:10 pre-open check included', async () => {
    await repo.recentForTracker('t1', 1, { liveOnly: true });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        trackerId: 't1',
        NOT: [
          { triggeredBy: { array_contains: ['OVERNIGHT_REVIEW'] } },
          { triggeredBy: { array_contains: ['PRE_OPEN_REVIEW'] } },
          { triggeredBy: { array_contains: ['PRE_OPEN_CHECK'] } },
          // signal-trader's entry-plan row (the signal SL as an exitTrigger) is not a live look either.
          { triggeredBy: { array_contains: ['SIGNAL_ENTRY'] } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
  });
});

describe('SentinelVerdictRepository — exitTrigger (price triggers)', () => {
  // The file has no shared input builder; this is the minimal valid input.
  const input = (): RecordVerdictInput => ({
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
    packet: { position: { symbol: 'INFY' } },
    promptVersion: 'v6/t1',
    triggeredBy: ['heartbeat'],
    netPnl: 1200,
    greenFloor: 1455,
  });

  it('writes exitTrigger only when given (omitted = SQL NULL; existing callers unchanged)', async () => {
    const create = jest.fn().mockResolvedValue({});
    const repo = new SentinelVerdictRepository({ sentinelVerdict: { create } } as never);
    await repo.record({ ...input(), exitTrigger: { v: 1, problem: 'x' } });
    expect(create.mock.calls[0][0].data.exitTrigger).toEqual({ v: 1, problem: 'x' });
    await repo.record(input());
    expect('exitTrigger' in create.mock.calls[1][0].data).toBe(false);
  });

  it('writes newsShadow only when given one (observe mode); otherwise the create data is unchanged', async () => {
    const create = jest.fn().mockResolvedValue({});
    const repo = new SentinelVerdictRepository({ sentinelVerdict: { create } } as never);
    await repo.record({ ...input(), newsShadow: { news: {}, events: {} } });
    expect(create.mock.calls[0][0].data.newsShadow).toEqual({ news: {}, events: {} });
    await repo.record(input());
    expect('newsShadow' in create.mock.calls[1][0].data).toBe(false);
    await repo.record({ ...input(), newsShadow: null });
    expect('newsShadow' in create.mock.calls[2][0].data).toBe(false);
  });

  it('a write that fails WITH newsShadow is retried once without it — the observe shadow never costs a verdict', async () => {
    const create = jest.fn().mockRejectedValueOnce(new Error('invalid input syntax for type json')).mockResolvedValueOnce({ id: 'v9' });
    const repo = new SentinelVerdictRepository({ sentinelVerdict: { create } } as never);
    await expect(repo.record({ ...input(), newsShadow: { news: {}, events: {} } })).resolves.toEqual({ id: 'v9' });
    expect(create).toHaveBeenCalledTimes(2);
    expect('newsShadow' in create.mock.calls[1][0].data).toBe(false);
    expect(create.mock.calls[1][0].data.verdict).toBe(create.mock.calls[0][0].data.verdict);
  });

  it('a write that fails WITHOUT newsShadow is not retried (exactly today)', async () => {
    const create = jest.fn().mockRejectedValue(new Error('db down'));
    const repo = new SentinelVerdictRepository({ sentinelVerdict: { create } } as never);
    await expect(repo.record(input())).rejects.toThrow('db down');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
