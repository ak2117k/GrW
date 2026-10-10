import { WatchedPositionRepository } from './watched-position.repository';

const T = (iso: string) => new Date(iso);

const verdictRow = (over: Record<string, unknown>) => ({
  trackerId: 't1',
  verdict: 'HOLD',
  confidence: 'high',
  thesisStatus: 'INTACT',
  reason: 'ok',
  invalidationPoint: 'x',
  evidence: ['money.netPnl'],
  netPnl: 10,
  greenFloor: null,
  triggeredBy: ['heartbeat'],
  createdAt: T('2026-10-12T09:00:00.000Z'),
  ...over,
});

function make(verdicts: unknown[]) {
  const prisma = {
    tradeTracker: {
      findMany: jest.fn().mockResolvedValue([
        { id: 't1', symbol: 'NIFTY13OCT2625000CE', exchange: 'NFO', token: '1', qty: 75, entryPrice: 140, lastLtp: 120, entryTime: T('2026-10-12T04:00:00.000Z') },
      ]),
    },
    sentinelVerdict: { findMany: jest.fn().mockResolvedValue(verdicts) },
    sentinelThesis: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return new WatchedPositionRepository(prisma as never);
}

describe('WatchedPositionRepository — live verdict and overnight plan side by side', () => {
  it('the live verdict ignores overnight rows; the overnight plan is the latest overnight or pre-open row', async () => {
    const repo = make([
      // newest first, as the query orders them
      verdictRow({ verdict: 'TIGHTEN_AT_OPEN', triggeredBy: ['PRE_OPEN_REVIEW', 'window:PRE_OPEN_REVIEW:ALL:2026-10-13'], createdAt: T('2026-10-13T03:20:00.000Z'), reason: 'OVERNIGHT RISK: a\nOPEN PLAN: b' }),
      verdictRow({ verdict: 'HOLD_OVERNIGHT', triggeredBy: ['OVERNIGHT_REVIEW', 'window:OVERNIGHT_REVIEW:EQUITY:2026-10-12'], createdAt: T('2026-10-12T10:15:00.000Z') }),
      verdictRow({ verdict: 'EXIT_ARMED', createdAt: T('2026-10-12T09:55:00.000Z') }),
    ]);
    const [p] = await repo.listForUser('u1');
    expect(p.verdict?.verdict).toBe('EXIT_ARMED');
    expect(p.overnight).toEqual(
      expect.objectContaining({
        verdict: 'TIGHTEN_AT_OPEN',
        kind: 'PRE_OPEN_REVIEW',
        reason: 'OVERNIGHT RISK: a\nOPEN PLAN: b',
        at: T('2026-10-13T03:20:00.000Z'),
      }),
    );
  });

  it('a position never reviewed overnight has a null overnight plan', async () => {
    const [p] = await make([verdictRow({})]).listForUser('u1');
    expect(p.verdict?.verdict).toBe('HOLD');
    expect(p.overnight).toBeNull();
  });

  it('a position with only overnight rows has no live verdict yet', async () => {
    const [p] = await make([
      verdictRow({ verdict: 'HOLD_OVERNIGHT', triggeredBy: ['OVERNIGHT_REVIEW', 'window:x'] }),
    ]).listForUser('u1');
    expect(p.verdict).toBeNull();
    expect(p.overnight?.kind).toBe('OVERNIGHT_REVIEW');
  });
});
