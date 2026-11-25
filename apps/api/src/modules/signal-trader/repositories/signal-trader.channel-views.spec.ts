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

const INFO_ROW = { channelId: 'ch-sg', postedAt: POSTED, items: [{ underlying: 'NIFTY', sentiment: 'BEARISH' }] };

function make(readings: unknown[] = [READING], infos: unknown[] = []) {
  const prisma = {
    channelInfo: { findMany: jest.fn(async () => infos) },
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
    jest.useRealTimers();
  });

  it('channelViews has no verifiedNotes when the flag is off (the repository ignores process.env)', async () => {
    process.env.MESSAGE_READER = 'on'; // must not matter: the caller decides
    const m = make();
    const v = await m.repo.channelViews('SENSEX', NOW);
    expect(v).toEqual({ status: 'unavailable', reason: 'no Telegram INFO posts in the last 24 h' });
    const off = await m.repo.channelViews('SENSEX', NOW, null, false);
    expect(off).toEqual({ status: 'unavailable', reason: 'no Telegram INFO posts in the last 24 h' });
    expect(m.prisma.messageReading.findMany).not.toHaveBeenCalled();
  });

  it('off on the PRESENT path (channel_infos rows) returns the pre-reader shape and never reads message_readings', async () => {
    const m = make([READING], [INFO_ROW]);
    const v = await m.repo.channelViews('NIFTY', NOW, null, false);
    expect(Object.keys(v).sort()).toEqual(['others', 'source', 'status', 'underlying']);
    expect(v).toMatchObject({ status: 'present', source: expect.stringContaining('channel_infos') });
    expect(m.prisma.messageReading.findMany).not.toHaveBeenCalled();
    expect(m.prisma.telegramChannel.findMany).not.toHaveBeenCalled();
  });

  it('off: a channel_infos failure still throws as before (the caller states it unavailable)', async () => {
    const m = make();
    m.prisma.channelInfo.findMany.mockRejectedValueOnce(new Error('relation "channel_infos" does not exist'));
    await expect(m.repo.channelViews('NIFTY', NOW, null, false)).rejects.toThrow('channel_infos');
  });

  it('on: a channel_infos failure keeps the notes', async () => {
    const m = make();
    m.prisma.channelInfo.findMany.mockRejectedValueOnce(new Error('relation "channel_infos" does not exist'));
    const v = await m.repo.channelViews('SENSEX', NOW, null, true);
    expect(v).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('channel_infos') });
    expect(v.verifiedNotes).toHaveLength(1);
  });

  it('on: the notes read is bounded at 2000 ms; the channel views still come back', async () => {
    jest.useFakeTimers();
    const m = make([READING], [INFO_ROW]);
    m.prisma.messageReading.findMany.mockImplementationOnce(() => new Promise(() => undefined));
    const p = m.repo.channelViews('NIFTY', NOW, null, true);
    await jest.advanceTimersByTimeAsync(2_000);
    const v = await p;
    expect(v).toMatchObject({ status: 'present', verifiedNotes: [], verifiedNotesUnavailable: 'timed out after 2000 ms' });
  });

  it("channelViews includes today's MARKET CONFIRMED note in on mode", async () => {
    const m = make();
    const v = await m.repo.channelViews('SENSEX', NOW, null, true);
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
    const none = make([]);
    expect((await none.repo.channelViews('NIFTY', NOW, null, true)).verifiedNotes).toEqual([]);
    const broken = make();
    broken.prisma.messageReading.findMany.mockRejectedValueOnce(new Error('relation "message_readings" does not exist'));
    const v = await broken.repo.channelViews('NIFTY', NOW, null, true);
    expect(v.verifiedNotes).toEqual([]);
    expect(v.verifiedNotesUnavailable).toMatch(/message_readings/);
  });
});
