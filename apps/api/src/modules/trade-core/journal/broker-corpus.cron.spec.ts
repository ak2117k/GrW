import type { JobRunnerService } from '../../../common/job-registry';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import { BROKER_CORPUS_SOURCE } from './broker-corpus';
import { BrokerCorpusCron, CORE_BROKER_CORPUS_JOB } from './broker-corpus.cron';

const NOW = new Date('2026-10-13T10:50:00.000Z'); // 16:20 IST
const closed = (id: string, over: Record<string, unknown> = {}) => ({
  id, userId: 'user_A', symbol: 'NIFTY14OCT2525000CE', exchange: 'NFO', token: '45000', kind: 'POSITION', entryPrice: 100, qty: 75,
  entryTime: new Date('2026-10-13T04:00:00.000Z'), exitPrice: 120, exitTime: new Date('2026-10-13T05:30:00.000Z'), status: 'CLOSED',
  holdingHigh: 130, holdingLow: 90, ...over,
});

function setup(trackers: unknown[], existing: string[] = []) {
  const prisma = {
    tradeTracker: { findMany: jest.fn().mockResolvedValue(trackers) },
    sentinelVerdict: { findMany: jest.fn().mockResolvedValue([]) },
    aiDecisionRecord: {
      findMany: jest.fn().mockResolvedValue(existing.map((sourceId) => ({ sourceId }))),
      createMany: jest.fn().mockImplementation(({ data }: { data: unknown[] }) => Promise.resolve({ count: data.length })),
    },
  };
  const jobs = { run: jest.fn((_n: string, _o: unknown, fn: () => Promise<unknown>) => fn()) };
  return { prisma, jobs, cron: new BrokerCorpusCron(prisma as unknown as PrismaService, jobs as unknown as JobRunnerService) };
}

describe('BrokerCorpusCron (Task 13b)', () => {
  it('scans closed POSITION trackers of the look-back window and writes one record each, skipDuplicates', async () => {
    const s = setup([closed('trk_1'), closed('trk_2', { kind: 'HOLDING' }), closed('trk_3', { symbol: 'RELIANCE-EQ', exchange: 'NSE' })]);
    expect(await s.cron.sync(NOW)).toEqual({ scanned: 3, written: 1, already: 0, skipped: { NOT_POSITION: 1, NOT_DERIVATIVE: 1 } });
    expect(s.prisma.tradeTracker.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: 'CLOSED', kind: 'POSITION', exitTime: { gte: new Date(NOW.getTime() - 7 * 86_400_000) } },
      take: 2_000,
    }));
    expect(s.prisma.sentinelVerdict.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { trackerId: { in: ['trk_1', 'trk_2', 'trk_3'] } } }));
    const { data, skipDuplicates } = s.prisma.aiDecisionRecord.createMany.mock.calls[0][0] as { data: Array<{ sourceId: string; source: string }>; skipDuplicates: boolean };
    expect(skipDuplicates).toBe(true);
    expect(data.map((d) => [d.source, d.sourceId])).toEqual([[BROKER_CORPUS_SOURCE, 'trk_1']]);
  });

  it('a rerun writes nothing for trackers that already have a record', async () => {
    const s = setup([closed('trk_1')], ['trk_1']);
    expect(await s.cron.sync(NOW)).toMatchObject({ written: 0, already: 1 });
    expect(s.prisma.aiDecisionRecord.createMany).not.toHaveBeenCalled();
  });

  it('runs through the job runner under its name; a failure is logged, never thrown', async () => {
    const s = setup([]);
    await s.cron.run(NOW);
    expect(s.jobs.run).toHaveBeenCalledWith(CORE_BROKER_CORPUS_JOB, expect.objectContaining({ onRedisError: 'run-anyway' }), expect.any(Function));
    s.jobs.run.mockRejectedValueOnce(new Error('lease lost'));
    await expect(s.cron.run(NOW)).resolves.toBeUndefined();
  });
});

describe('BrokerCorpusCron — bounded verdict read (review fix 6)', () => {
  it('reads verdicts only for trackers without a record, selecting only the columns the record uses (no packet / evidence)', async () => {
    const s = setup([closed('trk_1'), closed('trk_2')], ['trk_1']);
    expect(await s.cron.sync(NOW)).toMatchObject({ written: 1, already: 1 });
    const args = s.prisma.sentinelVerdict.findMany.mock.calls[0][0] as { where: unknown; select: Record<string, boolean> };
    expect(args.where).toEqual({ trackerId: { in: ['trk_2'] } });
    expect(Object.keys(args.select).sort()).toEqual(
      ['confidence', 'createdAt', 'greenFloor', 'id', 'netPnl', 'promptVersion', 'reason', 'recoveryAvailable', 'thesisStatus', 'trackerId', 'triggeredBy', 'verdict'],
    );
  });

  it('when every tracker already has a record no verdict is read', async () => {
    const s = setup([closed('trk_1')], ['trk_1']);
    await s.cron.sync(NOW);
    expect(s.prisma.sentinelVerdict.findMany).not.toHaveBeenCalled();
  });
});
