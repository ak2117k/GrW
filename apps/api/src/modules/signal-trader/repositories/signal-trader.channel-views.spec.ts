import { SignalTraderRepository } from './signal-trader.repository';

// 2026-11-25 09:31 IST: Stock Gainers' "STAY CAUTIOUS — ONLY INDEX SHOWING STRENGTH", read and confirmed.
const POSTED = new Date('2026-11-25T04:01:00.000Z');
const NOW = new Date('2026-11-25T04:02:00.000Z'); // 09:32 IST
const READING = {
  messageId: 'm1',
  channelId: 'ch-sg',
  postedAt: POSTED,
  scope: 'MARKET',
  claims: [
    {
      text: 'only index showing strength, stocks weak',
      subject: 'MARKET',
      bias: 'CAUTION',
      horizon: 'INTRADAY',
      verdict: 'CONFIRMED',
      evidence: [{ fact: 'NIFTY change', value: '+0.4%', source: 'indices' }, { fact: 'adv/dec', value: '0.45', source: 'breadth' }],
      claimType: 'RELATIVE_BREADTH',
    },
    { text: 'stay cautious', subject: 'MARKET', bias: 'CAUTION', horizon: 'INTRADAY', verdict: 'NOT_CHECKABLE', evidence: [], claimType: 'CAUTION' },
  ],
  summary: 'Caution: index strong, stocks weak',
};

function make(readings: unknown[] = [READING]) {
  const prisma = {
    channelInfo: { findMany: jest.fn(async () => []) },
    selfReviewRun: { findFirst: jest.fn(async () => null) },
    messageReading: { findMany: jest.fn(async () => readings) },
    telegramChannel: { findMany: jest.fn(async () => [{ id: 'ch-sg', title: 'Stock Gainers (SEBI Registered)' }]) },
  };
  return { prisma, repo: new SignalTraderRepository(prisma as never) };
}

describe('channelViews verifiedNotes (MESSAGE_READER)', () => {
  const OLD = process.env.MESSAGE_READER;
  afterEach(() => {
    if (OLD === undefined) delete process.env.MESSAGE_READER;
    else process.env.MESSAGE_READER = OLD;
  });

  it('channelViews has no verifiedNotes in shadow mode', async () => {
    for (const mode of ['shadow', 'off', '']) {
      process.env.MESSAGE_READER = mode;
      const m = make();
      const v = await m.repo.channelViews('SENSEX', NOW);
      expect(v).toEqual({ status: 'unavailable', reason: 'no Telegram INFO posts in the last 24 h' });
      expect(m.prisma.messageReading.findMany).not.toHaveBeenCalled();
    }
  });

  it("channelViews includes today's MARKET CONFIRMED note in on mode", async () => {
    process.env.MESSAGE_READER = 'on';
    const m = make();
    const v = await m.repo.channelViews('SENSEX', NOW);
    expect(v).toMatchObject({ status: 'unavailable', verifiedNotesSource: 'message_readings (AI present-state check), today' });
    expect(v.verifiedNotes).toEqual([
      {
        channel: 'Stock Gainers (SEBI Registered)',
        at: '09:31',
        scope: 'MARKET',
        subject: 'MARKET',
        claim: 'only index showing strength, stocks weak',
        bias: 'CAUTION',
        verdict: 'CONFIRMED',
        evidence: READING.claims[0].evidence,
      },
    ]);
    const where = (m.prisma.messageReading.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toEqual({ sessionDate: '2026-11-25', status: { in: ['READ', 'CACHED'] }, postedAt: { lte: NOW } });
  });

  it('verifiedNotes in on mode: an empty array when nothing is checked today; stated unavailable when the read fails', async () => {
    process.env.MESSAGE_READER = 'on';
    const none = make([]);
    expect((await none.repo.channelViews('NIFTY', NOW)).verifiedNotes).toEqual([]);
    const broken = make();
    broken.prisma.messageReading.findMany.mockRejectedValueOnce(new Error('relation "message_readings" does not exist'));
    const v = await broken.repo.channelViews('NIFTY', NOW);
    expect(v.verifiedNotes).toEqual([]);
    expect(v.verifiedNotesUnavailable).toMatch(/message_readings/);
  });
});
