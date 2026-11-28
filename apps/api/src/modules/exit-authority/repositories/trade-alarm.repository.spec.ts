import type { PrismaService } from '../../../common/prisma/prisma.service';
import { TradeAlarmRepository } from './trade-alarm.repository';

type Verdict = { id: string; trackerId: string; verdict: string; createdAt: Date; promptVersion: string; reason?: string };
type Alarm = { id: string; status: string; answeredAt?: Date | null; answerVerdictId?: string | null; answer?: string | null };

/** A tiny in-memory sentinel_verdicts / trade_alarms honouring the where clauses the repository sends. */
function fakePrisma(verdicts: Verdict[], alarms: Alarm[] = []) {
  return {
    sentinelVerdict: {
      findMany: jest.fn(async (q: { where: { trackerId: string; createdAt: { gt: Date }; promptVersion: { startsWith: string } }; take: number }) =>
        verdicts
          .filter((v) => v.trackerId === q.where.trackerId && v.createdAt > q.where.createdAt.gt && v.promptVersion.startsWith(q.where.promptVersion.startsWith))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, q.take)),
    },
    tradeAlarm: {
      updateMany: jest.fn(async (q: { where: { id: string; status: { in: string[] } }; data: Partial<Alarm> }) => {
        const hit = alarms.filter((a) => a.id === q.where.id && q.where.status.in.includes(a.status));
        for (const a of hit) Object.assign(a, q.data);
        return { count: hit.length };
      }),
    },
  };
}

const T0 = new Date('2026-11-27T05:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);

describe('TradeAlarmRepository.latestAgentVerdict — only the sentinel judge answers an alarm', () => {
  const base = { trackerId: 'trk1', verdict: 'HOLD' };

  it('a desk-manager TIGHTEN row and a signal-trader SL row newer than the alarm do NOT answer it', async () => {
    const prisma = fakePrisma([
      { ...base, id: 'desk', createdAt: at(20), promptVersion: 'desk-manager/1' },
      { ...base, id: 'sig', createdAt: at(30), promptVersion: 'signal-trader-v1' },
      { ...base, id: 'rule', createdAt: at(40), promptVersion: 'rule:floor-hard/1', verdict: 'EXIT_NOW' },
      { ...base, id: 'night', createdAt: at(50), promptVersion: 'o4/t2' },
    ]);
    const repo = new TradeAlarmRepository(prisma as unknown as PrismaService);
    await expect(repo.latestAgentVerdict('trk1', at(10))).resolves.toBeNull();
  });

  it('a sentinel verdict (incl. the +x1 authority stamp) answers it, even behind newer non-agent rows', async () => {
    const prisma = fakePrisma([
      { ...base, id: 'agent', createdAt: at(20), promptVersion: 'v9+l1+d1+e1+s1+a1+x1/t2', verdict: 'EXIT_NOW' },
      { ...base, id: 'desk', createdAt: at(30), promptVersion: 'desk-manager/1' },
      { ...base, id: 'vodd', createdAt: at(40), promptVersion: 'vertex-something' },
    ]);
    const repo = new TradeAlarmRepository(prisma as unknown as PrismaService);
    await expect(repo.latestAgentVerdict('trk1', at(10))).resolves.toEqual({ id: 'agent', verdict: 'EXIT_NOW', createdAt: at(20) });
    await expect(repo.latestAgentVerdict('trk1', at(25))).resolves.toBeNull();
  });

  it('authority drill: a drill look\'s row (drill-tagged reason, any verdict) never answers a REAL alarm; only the drill alarm (includeDrill)', async () => {
    const prisma = fakePrisma([
      { ...base, id: 'real-look', createdAt: at(20), promptVersion: 'v12/t2', reason: 'thesis intact' },
      { ...base, id: 'drill-adv', createdAt: at(30), promptVersion: 'v12/t2', verdict: 'EXIT_ADVISORY', reason: '[advisory: authority drill] broke' },
      { ...base, id: 'drill-hold', createdAt: at(40), promptVersion: 'v12/t2', reason: '[advisory: authority drill] holding' },
    ]);
    const repo = new TradeAlarmRepository(prisma as unknown as PrismaService);
    await expect(repo.latestAgentVerdict('trk1', at(10))).resolves.toEqual({ id: 'real-look', verdict: 'HOLD', createdAt: at(20) });
    await expect(repo.latestAgentVerdict('trk1', at(25))).resolves.toBeNull();
    await expect(repo.latestAgentVerdict('trk1', at(25), { includeDrill: true })).resolves.toEqual({ id: 'drill-hold', verdict: 'HOLD', createdAt: at(40) });
  });
});

describe('TradeAlarmRepository.answerIfOpen — conditional', () => {
  it.each(['OPEN', 'SNOOZED'])('%s → ANSWERED, true', async (status) => {
    const row: Alarm = { id: 'a1', status };
    const repo = new TradeAlarmRepository(fakePrisma([], [row]) as unknown as PrismaService);
    await expect(repo.answerIfOpen('a1', { answeredAt: at(5), answerVerdictId: 'v1', answer: 'HOLD' })).resolves.toBe(true);
    expect(row).toMatchObject({ status: 'ANSWERED', answerVerdictId: 'v1', answer: 'HOLD' });
  });

  it.each(['BACKSTOPPED', 'CLOSED', 'ANSWERED'])('%s is never resurrected or overwritten, false', async (status) => {
    const row: Alarm = { id: 'a1', status, answer: 'first' };
    const repo = new TradeAlarmRepository(fakePrisma([], [row]) as unknown as PrismaService);
    await expect(repo.answerIfOpen('a1', { answeredAt: at(5), answerVerdictId: 'v2', answer: 'late' })).resolves.toBe(false);
    expect(row).toEqual({ id: 'a1', status, answer: 'first' });
  });
});
