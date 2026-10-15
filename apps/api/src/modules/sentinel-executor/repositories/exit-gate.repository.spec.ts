import { ExitGateRepository } from './exit-gate.repository';

describe('ExitGateRepository', () => {
  const prisma = {
    $queryRaw: jest.fn(),
    sentinelVerdict: { findUnique: jest.fn() },
    coreRiskLimit: { findFirst: jest.fn() },
    coreJournal: { findUnique: jest.fn() },
  };
  const repo = new ExitGateRepository(prisma as never);
  beforeEach(() => jest.clearAllMocks());

  it('verdictPacket selects only the packet', async () => {
    prisma.sentinelVerdict.findUnique.mockResolvedValue({ packet: { a: 1 } });
    await expect(repo.verdictPacket('v1')).resolves.toEqual({ a: 1 });
    expect(prisma.sentinelVerdict.findUnique).toHaveBeenCalledWith({ where: { id: 'v1' }, select: { packet: true } });
    prisma.sentinelVerdict.findUnique.mockResolvedValue(null);
    await expect(repo.verdictPacket('v1')).resolves.toBeNull();
  });

  it('recentVerdicts: live rows only, before the current, numeric JSON extraction, newest first', async () => {
    prisma.$queryRaw.mockResolvedValue([
      { id: 'a', verdict: 'HOLD', createdAt: new Date('2026-10-14T10:50:00Z'), underlying: 8998, support: 8946, resistance: null },
    ]);
    const rows = await repo.recentVerdicts('t1', 'cur', new Date('2026-10-14T11:01:00Z'), new Date('2026-10-14T10:01:00Z'));
    expect(rows).toEqual([{ id: 'a', verdict: 'HOLD', createdAt: new Date('2026-10-14T10:50:00Z'), underlying: 8998, support: 8946, resistance: null }]);
    const sql = (prisma.$queryRaw.mock.calls[0][0] as { strings: string[] }).strings.join('?');
    expect(sql).toMatch(/"promptVersion" !~ '\^o\[0-9\]\+\/'/);
    expect(sql).toMatch(/jsonb_typeof/);
    expect(sql).toMatch(/ORDER BY v\."createdAt" DESC/);
    expect(sql).toMatch(/"id" <> /);
  });

  it('maxRiskPerTrade: the effective ALL-scope row, as a number', async () => {
    prisma.coreRiskLimit.findFirst.mockResolvedValue({ numValue: { toString: () => '2000.00' } });
    await expect(repo.maxRiskPerTrade('u', new Date('2026-10-14T11:00:00Z'))).resolves.toBe(2000);
    expect(prisma.coreRiskLimit.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: 'u', key: 'maxRiskPerTrade', scope: 'ALL', effectiveFrom: { lte: new Date('2026-10-14T11:00:00Z') } }),
      // The risk wall's rule (resolveAppendOnly): the most recently CREATED row already in force; id breaks a tie.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }));
    prisma.coreRiskLimit.findFirst.mockResolvedValue(null);
    await expect(repo.maxRiskPerTrade('u', new Date())).resolves.toBeNull();
  });

  it('dailyLossLatched: the daily-loss monitor dedupeKey for the IST day', async () => {
    prisma.coreJournal.findUnique.mockResolvedValue({ id: 'j' });
    await expect(repo.dailyLossLatched('u', '2026-10-14')).resolves.toBe(true);
    expect(prisma.coreJournal.findUnique).toHaveBeenCalledWith({ where: { dedupeKey: 'latch:u:2026-10-14' }, select: { id: true } });
  });
});
