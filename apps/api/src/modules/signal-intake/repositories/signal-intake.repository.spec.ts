import { SignalIntakeRepository } from './signal-intake.repository';
import { capturedSql, sessionBounds } from '../../market-hub/testing/captured-sql';

describe('SignalIntakeRepository.saveClass — telegram_messages.parseStatus mirrors the class (audit 2026-11-27: always "pending")', () => {
  const make = (o: { failParse?: boolean } = {}) => {
    const prisma = {
      signalMessageClass: { upsert: jest.fn(async () => undefined) },
      telegramMessage: {
        updateMany: jest.fn(async () => {
          if (o.failParse) throw new Error('db down');
          return { count: 1 };
        }),
      },
    };
    return { repo: new SignalIntakeRepository(prisma as never), prisma };
  };
  const row = { messageId: 'tm1', channelId: 'ch1', postedAt: new Date('2026-11-27T04:00:00Z'), textHash: 'h', status: 'RECAP' as const, reason: 'result: gains done' };

  it('writes the class row, then sets parseStatus to the class', async () => {
    const { repo, prisma } = make();
    await repo.saveClass(row);
    expect(prisma.signalMessageClass.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.telegramMessage.updateMany).toHaveBeenCalledWith({ where: { id: 'tm1', NOT: { parseStatus: 'RECAP' } }, data: { parseStatus: 'RECAP' } });
  });

  it('a parseStatus write failure never fails the class write', async () => {
    const { repo, prisma } = make({ failParse: true });
    await expect(repo.saveClass(row)).resolves.toBeUndefined();
    expect(prisma.signalMessageClass.upsert).toHaveBeenCalledTimes(1);
  });
});

describe('SignalIntakeRepository.refCloses — previous session close from candles_1m (prod: candles_1d has no row since 2026-09-30)', () => {
  type Row = { name: string; src: '1m' | '1d'; day: string; close: number };
  const make = (rows: Row[]) => {
    const prisma = { $queryRaw: jest.fn(async () => rows), hubCandle1d: { findFirst: jest.fn(async () => null) } };
    return { repo: new SignalIntakeRepository(prisma as never), prisma };
  };
  // 2026-11-27 15:05 IST (the "Sensex 62500 pe" post).
  const at = new Date('2026-11-27T09:35:00Z');

  it('reads every index in ONE query: candles_1m session minutes before the IST day of `at`, plus the candles_1d fallback', async () => {
    const { repo, prisma } = make([]);
    await repo.refCloses(at);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.hubCandle1d.findFirst).not.toHaveBeenCalled();
    const q = capturedSql(prisma.$queryRaw.mock.calls as unknown[][]);
    expect(q.text).toMatch(/candles_1m/);
    expect(q.text).toMatch(/candles_1d/);
    expect(sessionBounds(q)).toEqual({ from: '09:15', to: '15:30' });
    // The cutoff is IST midnight of 27-Nov (26-Nov 18:30 UTC): today's own bars are never the reference.
    const cut = q.values.filter((v): v is Date => v instanceof Date).map((d) => d.toISOString());
    expect(cut).toContain('2026-11-26T18:30:00.000Z');
    expect(cut.every((d) => d <= '2026-11-26T18:30:00.000Z')).toBe(true);
    for (const tok of ['99926000', '99926009', '99926037', '99926074', '99919000', '12']) expect(q.values).toContain(tok);
  });

  it('maps the real 26-Nov 1m closes; the stale 30-Sep daily bar never wins over a newer session', async () => {
    const { repo } = make([
      { name: 'NIFTY', src: '1m', day: '2026-11-26', close: 25600.5 },
      { name: 'NIFTY', src: '1d', day: '2026-10-01', close: 22400 },
      { name: 'BANKNIFTY', src: '1m', day: '2026-11-26', close: 63000.1 },
      { name: 'SENSEX', src: '1m', day: '2026-11-26', close: 83300.2 },
      { name: 'FINNIFTY', src: '1m', day: '2026-11-26', close: 28300 },
    ]);
    const m = await repo.refCloses(at);
    expect(Object.fromEntries(m)).toEqual({ NIFTY: 25600.5, BANKNIFTY: 63000.1, SENSEX: 83300.2, FINNIFTY: 28300 });
  });

  it('a candles_1d bar wins only when its day is newer than the last 1m session; same day keeps the 1m close', async () => {
    const { repo } = make([
      { name: 'NIFTY', src: '1m', day: '2026-11-20', close: 25000 },
      { name: 'NIFTY', src: '1d', day: '2026-11-26', close: 25610 },
      { name: 'SENSEX', src: '1d', day: '2026-11-26', close: 83000 },
      { name: 'SENSEX', src: '1m', day: '2026-11-26', close: 83339.26 },
      { name: 'BANKEX', src: '1d', day: '2026-11-25', close: 70000 },
    ]);
    const m = await repo.refCloses(at);
    expect(m.get('NIFTY')).toBe(25610);
    expect(m.get('SENSEX')).toBe(83339.26);
    expect(m.get('BANKEX')).toBe(70000);
  });

  it('drops non-finite / non-positive closes and names outside the index map', async () => {
    const { repo } = make([
      { name: 'NIFTY', src: '1m', day: '2026-11-26', close: 0 },
      { name: 'BANKNIFTY', src: '1m', day: '2026-11-26', close: Number.NaN },
      { name: 'FOO', src: '1m', day: '2026-11-26', close: 100 },
      { name: 'SENSEX', src: '1m', day: '2026-11-26', close: '83339.26' as unknown as number },
    ]);
    const m = await repo.refCloses(at);
    expect(Object.fromEntries(m)).toEqual({ SENSEX: 83339.26 });
  });
});
