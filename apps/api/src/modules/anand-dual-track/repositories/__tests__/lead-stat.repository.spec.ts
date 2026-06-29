import { AnandDualTrackRepository } from '../anand-dual-track.repository';

function makePrismaMock() {
  const store = new Map<string, { count: number; dates: string[]; lastLedAt: Date }>();
  return {
    store,
    symbolLeadStat: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const key = `${where.symbol_track.symbol}:${where.symbol_track.track}`;
        const existing = store.get(key);
        if (!existing) {
          store.set(key, { count: create.count, dates: create.dates, lastLedAt: create.lastLedAt });
        } else {
          existing.count = update.count.increment ? existing.count + update.count.increment : update.count;
          existing.dates = update.dates;
          existing.lastLedAt = update.lastLedAt;
        }
        return store.get(key);
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const key = `${where.symbol}:${where.track}`;
        return store.get(key) ?? null;
      }),
      findMany: jest.fn(async ({ where }: any) => {
        const out: any[] = [];
        for (const [key, v] of store) {
          const [symbol, track] = key.split(':');
          if (track === where.track && where.symbol.in.includes(symbol)) out.push({ symbol, ...v });
        }
        return out;
      }),
    },
  };
}

describe('AnandDualTrackRepository lead stats', () => {
  it('bumpLeadStat creates then increments count and appends a date', async () => {
    const prisma = makePrismaMock();
    const repo = new AnandDualTrackRepository(prisma as any);

    await repo.bumpLeadStat('swing', 'TCS');
    await repo.bumpLeadStat('swing', 'TCS');

    const stat = prisma.store.get('TCS:swing')!;
    expect(stat.count).toBe(2);
    expect(stat.dates).toHaveLength(2);
  });

  it('getLeadStats returns a symbol→{count,dates} map', async () => {
    const prisma = makePrismaMock();
    const repo = new AnandDualTrackRepository(prisma as any);
    await repo.bumpLeadStat('swing', 'TCS');

    const map = await repo.getLeadStats('swing', ['TCS', 'INFY']);
    expect(map.get('TCS')?.count).toBe(1);
    expect(map.get('INFY')).toBeUndefined();
  });
});
