import { LevelBreakLogService } from './level-break-log.service';

const OPEN = Date.parse('2026-10-23T03:45:00Z'); // 09:15 IST
const M = 60_000;

/** A 15m staircase that ranges under 22,600 for days, then breaks up hard on the last bar. */
function nifty1m(sessions: number, breakAtEnd: boolean) {
  const rows: any[] = [];
  for (let d = sessions - 1; d >= 0; d--) {
    const dayOpen = OPEN - d * 86_400_000;
    for (let i = 0; i < 375; i++) {
      // oscillate between 22,500 and 22,600 with a 15m-bar period of 4 → clear swing highs at ~22,600
      const k = Math.floor(i / 15);
      const base = 22550 + (k % 4 === 0 ? 45 : k % 4 === 2 ? -45 : 0);
      rows.push({ ts: new Date(dayOpen + i * M), open: base, high: base + 5, low: base - 5, close: base, volume: 100 });
    }
  }
  if (breakAtEnd) {
    // last day: the 10:00–10:15 IST bar (minutes 45..59) closes far above the range
    const last = OPEN;
    for (let i = 45; i < 60; i++) rows.find((r) => r.ts.getTime() === last + i * M)!.close = 22680;
    for (let i = 45; i < 60; i++) rows.find((r) => r.ts.getTime() === last + i * M)!.high = 22685;
  }
  return rows;
}

function fakePrisma(bars: any[], oi: any[] = []) {
  const created: any[] = [];
  const updated: any[] = [];
  const prisma = {
    mbmBar1m: {
      findMany: jest.fn(async ({ where }: any) =>
        bars.filter((b) => b.ts >= where.ts.gte && b.ts <= where.ts.lte).sort((a, b) => a.ts - b.ts),
      ),
    },
    niftyOiHistory: { findMany: jest.fn(async () => oi) },
    levelBreakLog: {
      createMany: jest.fn(async ({ data }: any) => {
        created.push(...data);
        return { count: data.length };
      }),
      findMany: jest.fn(async () => created.map((c, i) => ({ id: `r${i}`, futOiNow: c.futOiNow, futOi15mBefore: c.futOi15mBefore, ...c }))),
      update: jest.fn(async (a: any) => {
        updated.push(a);
        return a;
      }),
    },
  };
  return { prisma: prisma as any, created, updated };
}

describe('LevelBreakLogService', () => {
  const breakEnd = OPEN + 60 * M; // 10:15 IST
  const oi = [40, 45, 50, 55].map((m, i) => ({ token: '48704', expiry: new Date('2026-10-27T00:00:00Z'), ts: new Date(OPEN + m * M), oi: 1_000_000 + i * 5_000 }));

  it('logs a NIFTY 15m zone break with the front-month futures OI now and 15 min before', async () => {
    const { prisma, created } = fakePrisma(nifty1m(12, true), oi);
    const svc = new LevelBreakLogService(prisma);
    const n = await svc.detect(new Date(breakEnd + 2 * M));
    expect(n).toBeGreaterThan(0);
    const row = created.find((c) => c.timeframe === '15m')!;
    expect(row).toMatchObject({ instrument: 'NIFTY', direction: 'UP', zoneType: 'resistance', price: 22680, futToken: '48704' });
    expect(row.ts.getTime()).toBe(breakEnd);
    expect(row.futOiNow).toBe(1_015_000); // 5m bar 10:10–10:15
    expect(row.futOi15mBefore).toBe(1_000_000); // 5m bar 09:55–10:00
    expect(row.futOiChange).toBe(15_000);
  });

  it('logs nothing without a break, and never throws on a DB error (fail-soft)', async () => {
    const quiet = fakePrisma(nifty1m(12, false), oi);
    expect(await new LevelBreakLogService(quiet.prisma).detect(new Date(breakEnd + 2 * M))).toBe(0);

    const broken = { mbmBar1m: { findMany: jest.fn(async () => { throw new Error('db down'); }) } } as any;
    await expect(new LevelBreakLogService(broken).detect(new Date(breakEnd + 2 * M))).resolves.toBe(0);
    await expect(new LevelBreakLogService(broken).fillOutcomes(new Date())).resolves.toEqual({ filled: 0, pending: 0 });
  });

  it('a stale last bar (holiday / feed gap) is not logged', async () => {
    const { prisma } = fakePrisma(nifty1m(12, true), oi);
    expect(await new LevelBreakLogService(prisma).detect(new Date(breakEnd + 3 * 3600_000))).toBe(0);
  });

  it('fills the follow-through after the session and closes the row', async () => {
    const f = fakePrisma(nifty1m(12, true), oi);
    const svc = new LevelBreakLogService(f.prisma);
    await svc.detect(new Date(breakEnd + 2 * M));
    const r = await svc.fillOutcomes(new Date(OPEN + 7 * 3600_000));
    expect(r.filled).toBeGreaterThan(0);
    const upd = f.updated[0].data;
    expect(upd.priceEod).toBe(22595); // last 1m bar of the day (k = 24 → top of the range)
    expect(upd.move15mPts).not.toBeNull();
    expect(upd.outcomeFilledAt).toBeInstanceOf(Date);
  });

  it('LEVEL_BREAK_LOG=off disables the crons', async () => {
    const { prisma } = fakePrisma([]);
    const svc = new LevelBreakLogService(prisma);
    process.env.LEVEL_BREAK_LOG = 'off';
    try {
      expect(svc.enabled).toBe(false);
      await svc.detectCron();
      await svc.outcomesCron();
      expect(prisma.mbmBar1m.findMany).not.toHaveBeenCalled();
    } finally {
      delete process.env.LEVEL_BREAK_LOG;
    }
  });
});
