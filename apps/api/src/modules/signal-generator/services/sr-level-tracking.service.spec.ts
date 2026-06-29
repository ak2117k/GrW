import { SrLevelTrackingService } from './sr-level-tracking.service';
import type { EvidenceLevel } from '../types/evidence-level.types';

const buildRepoMock = () => ({
  recordMany: jest.fn(async (rows: any[]) => rows.length),
  findUnevaluatedBefore: jest.fn(async () => [] as any[]),
  markEvaluated: jest.fn(async () => undefined),
  holdRateByKind: jest.fn(async () => ({})),
});

const lvl = (over: Partial<EvidenceLevel>): EvidenceLevel => ({
  price: 100,
  side: 'support',
  score: 70.4,
  kinds: ['VOLUME'],
  soft: false,
  distancePct: 1,
  ...over,
});

describe('SrLevelTrackingService.snapshot', () => {
  it('persists one row per non-soft level, rounding score and seeding atr', async () => {
    const repo = buildRepoMock();
    const svc = new SrLevelTrackingService(repo as any);

    const n = await svc.snapshot(
      '1234',
      'NSE',
      '15m',
      [lvl({ price: 100, soft: false }), lvl({ price: 95, soft: true })],
      99,
      4.2,
    );

    expect(n).toBe(1);
    expect(repo.recordMany).toHaveBeenCalledTimes(1);
    const rows = repo.recordMany.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      token: '1234',
      exchange: 'NSE',
      interval: '15m',
      price: 100,
      side: 'support',
      score: 70, // rounded from 70.4
      ltpAtSnapshot: 99,
      atr14: 4.2,
    });
  });

  it('does not call the repo when there are no hard levels', async () => {
    const repo = buildRepoMock();
    const svc = new SrLevelTrackingService(repo as any);
    const n = await svc.snapshot('1', 'NSE', '15m', [lvl({ soft: true })], 99, 1);
    expect(n).toBe(0);
    expect(repo.recordMany).not.toHaveBeenCalled();
  });

  it('seeds atr14 null when omitted', async () => {
    const repo = buildRepoMock();
    const svc = new SrLevelTrackingService(repo as any);
    await svc.snapshot('1', 'NSE', '15m', [lvl({})], 99);
    expect(repo.recordMany.mock.calls[0][0][0].atr14).toBeNull();
  });
});

describe('SrLevelTrackingService.evaluate', () => {
  const now = new Date('2026-06-28T10:00:00.000Z');

  it('is a no-op when no adapter is wired', async () => {
    const repo = buildRepoMock();
    const svc = new SrLevelTrackingService(repo as any); // no adapter
    const res = await svc.evaluate({ now });
    expect(res.evaluated).toBe(0);
    expect(repo.findUnevaluatedBefore).not.toHaveBeenCalled();
  });

  it('classifies a pending snapshot and persists the verdict', async () => {
    const repo = buildRepoMock();
    repo.findUnevaluatedBefore.mockResolvedValueOnce([
      {
        id: 'obs1',
        token: '1234',
        exchange: 'NSE',
        interval: '15m',
        price: 100,
        side: 'support',
        score: 70,
        kinds: ['VOLUME'],
        atr14: 5,
        snapshotAt: new Date('2026-06-28T07:00:00.000Z'),
      },
    ]);
    // support 100, atr5 → tol 1.5: touch then close decisively below → BROKE
    const adapter = {
      getHistoricalData: jest.fn(async () => [
        { timestamp: new Date(), open: 100, high: 101, low: 99, close: 99.5 },
        { timestamp: new Date(), open: 99, high: 99.5, low: 97, close: 98 },
      ]),
    };
    const svc = new SrLevelTrackingService(repo as any, adapter as any);

    const res = await svc.evaluate({ now, graceMinutes: 90 });

    expect(res.evaluated).toBe(1);
    // cutoff = now - 90m
    expect(repo.findUnevaluatedBefore).toHaveBeenCalledWith(new Date('2026-06-28T08:30:00.000Z'));
    expect(adapter.getHistoricalData).toHaveBeenCalledWith(
      '1234',
      'NSE',
      '15m',
      new Date('2026-06-28T07:00:00.000Z'),
      now,
    );
    expect(repo.markEvaluated).toHaveBeenCalledTimes(1);
    const [id, verdict] = repo.markEvaluated.mock.calls[0] as unknown as [string, any];
    expect(id).toBe('obs1');
    expect(verdict.touched).toBe(true);
    expect(verdict.reaction).toBe('BROKE');
    expect(verdict.evaluatedAt).toBe(now);
  });

  it('leaves a snapshot unevaluated when candle fetch throws', async () => {
    const repo = buildRepoMock();
    repo.findUnevaluatedBefore.mockResolvedValueOnce([
      {
        id: 'obs2',
        token: '1',
        exchange: 'NSE',
        interval: '15m',
        price: 100,
        side: 'resistance',
        score: 60,
        kinds: ['HISTORY'],
        atr14: 5,
        snapshotAt: new Date('2026-06-28T07:00:00.000Z'),
      },
    ]);
    const adapter = {
      getHistoricalData: jest.fn(async () => {
        throw new Error('throttled');
      }),
    };
    const svc = new SrLevelTrackingService(repo as any, adapter as any);

    const res = await svc.evaluate({ now });
    expect(res.evaluated).toBe(0);
    expect(repo.markEvaluated).not.toHaveBeenCalled();
  });
});
