import { AiSetupsRepository } from './ai-setups.repository';

const NOW = new Date('2026-11-25T08:48:00Z');

function make(o: { setup?: unknown; trades?: unknown[]; trackers?: unknown[]; armed?: unknown; summary?: unknown } = {}) {
  const prisma = {
    aiSetup: { findFirst: jest.fn(async () => o.setup ?? null), count: jest.fn(async () => 2), findMany: jest.fn(async () => []) },
    trade: { findMany: jest.fn(async () => o.trades ?? []) },
    tradeTracker: { findMany: jest.fn(async () => o.trackers ?? []) },
    signalDecision: { findFirst: jest.fn(async () => o.armed ?? null) },
    selfReviewRun: { findFirst: jest.fn(async () => (o.summary ? { summary: o.summary, startedAt: NOW } : null)) },
  };
  return { repo: new AiSetupsRepository(prisma as never), prisma };
}

const trade = (symbol: string, name: string, over: Record<string, unknown> = {}) => ({
  id: 't1', status: 'OPEN', strategy: 'TELEGRAM_SIGNAL_NO_FUNDS', isPaperTrade: true, entryTags: [], instrument: { name, symbol }, ...over,
});

describe('AiSetupsRepository.openOnUnderlying', () => {
  it('nothing open → null', async () => {
    expect(await make().repo.openOnUnderlying('DABUR', NOW)).toBeNull();
  });

  it('an AI setup PENDING / FILLED on the underlying blocks', async () => {
    expect(await make({ setup: { id: 's1', status: 'PENDING' } }).repo.openOnUnderlying('DABUR', NOW)).toMatch(/AI setup is PENDING on DABUR/);
  });

  it('an open signal paper trade on the underlying blocks; one on a longer name (DABURX…) does not', async () => {
    expect(await make({ trades: [trade('DABUR29DEC25430CE', 'DABUR')] }).repo.openOnUnderlying('dabur', NOW)).toMatch(/open signal trade on DABUR: paper TELEGRAM_SIGNAL_NO_FUNDS DABUR29DEC25430CE OPEN/);
    expect(await make({ trades: [trade('DABURX29DEC25430CE', 'DABURX')] }).repo.openOnUnderlying('DABUR', NOW)).toBeNull();
  });

  it('a live trade, a live position and an armed signal trigger each block', async () => {
    expect(await make({ trades: [trade('DABUR29DEC25430CE', 'DABUR', { isPaperTrade: false, strategy: null })] }).repo.openOnUnderlying('DABUR', NOW)).toMatch(/live/);
    expect(await make({ trackers: [{ symbol: 'DABUR29DEC25430CE' }] }).repo.openOnUnderlying('DABUR', NOW)).toMatch(/open live position on DABUR/);
    expect(await make({ armed: { id: 'd1' } }).repo.openOnUnderlying('DABUR', NOW)).toMatch(/trigger is armed on DABUR/);
  });

  it('asks trades for OPEN / PENDING signal-family paper or real-money rows, trackers for POSITIONs only, triggers from today', async () => {
    const m = make();
    await m.repo.openOnUnderlying('DABUR', NOW);
    const tWhere = (m.prisma.trade.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(tWhere.status).toEqual({ in: ['OPEN', 'PENDING'] });
    expect(JSON.stringify(tWhere)).toContain('"isPaperTrade":false');
    expect(JSON.stringify(tWhere)).toContain('TELEGRAM_SIGNAL_NO_FUNDS');
    expect((m.prisma.tradeTracker.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where).toMatchObject({ status: 'OPEN', kind: 'POSITION' });
    expect((m.prisma.signalDecision.findFirst.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where).toMatchObject({
      underlying: 'DABUR',
      decision: 'PENDING',
      createdAt: { gte: new Date('2026-11-24T18:30:00Z') },
    });
  });
});

describe('AiSetupsRepository packet sources', () => {
  it("channelRecord: the channel's byChannel entry from the newest DONE self-review; null when none", async () => {
    const m = make({ summary: { streams: { S: { byChannel: { 'ch-sg': { calls: 12, winRate: 0.42 } } } } } });
    expect(await m.repo.channelRecord('ch-sg')).toEqual({ asOf: NOW.toISOString(), calls: 12, winRate: 0.42 });
    expect(await m.repo.channelRecord('other')).toBeNull();
    expect(await make().repo.channelRecord('ch-sg')).toBeNull();
  });

  it('deskToday counts today’s setups from the IST day start', async () => {
    const m = make();
    const d = await m.repo.deskToday('2026-11-25', 'DABUR');
    expect(d).toMatchObject({ setupsToday: 2, openTrades: [], openSetups: [] });
    expect((m.prisma.aiSetup.count.mock.calls[0] as unknown as [{ where: { createdAt: { gte: Date } } }])[0].where.createdAt.gte).toEqual(new Date('2026-11-24T18:30:00Z'));
  });
});
