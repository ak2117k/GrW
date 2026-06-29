import { AnandDualTrackRepository } from '../anand-dual-track.repository';

describe('hasTargetHitTodayBySymbol', () => {
  function repoWith(rows: any[]) {
    const prisma = {
      swingEntry: { findFirst: jest.fn(async ({ where }: any) => {
        return rows.find(
          (r) =>
            r.symbol === where.symbol &&
            r.status === where.status &&
            r.exitedAt >= where.exitedAt.gte,
        ) ?? null;
      }) },
      intradayEntry: { findFirst: jest.fn(async () => null) },
    };
    return { repo: new AnandDualTrackRepository(prisma as any), prisma };
  }

  it('true when a TARGET_HIT exists for the symbol today (IST)', async () => {
    const { repo } = repoWith([{ symbol: 'TCS', status: 'TARGET_HIT', exitedAt: new Date() }]);
    expect(await repo.hasTargetHitTodayBySymbol('swing', 'TCS')).toBe(true);
  });

  it('false when no target-hit today', async () => {
    const { repo } = repoWith([]);
    expect(await repo.hasTargetHitTodayBySymbol('swing', 'TCS')).toBe(false);
  });
});
